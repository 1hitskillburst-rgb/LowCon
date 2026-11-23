import { estimateTokensConservative } from './context';
import { isLocalEndpoint, normalizeApiEndpoint, type DiagnosticLogger } from './privacy';
import type {
  ModelProfile,
  StructuredChatMessage,
  WorkerStatus,
} from './types';

export interface GenerationParams {
  exactRenderedPrompt: string;
  structuredMessages: StructuredChatMessage[];
  maxTokens: number;
  temperature: number;
  topP: number;
  stopSequences: string[];
  lmStudioEndpoint?: string;
  selectedLmModel?: string;
}

export type StreamCallbacks = {
  onToken: (token: string) => void;
  onComplete: (totalTokens: number, stopReason: 'done' | 'max_tokens' | 'stop_sequence') => void;
  onCancelled: () => void;
  onError: (message: string) => void;
};

export interface ParsedSseResult {
  deltaContent?: string;
  stopReason?: 'done' | 'max_tokens' | 'stop_sequence';
}

/**
 * Parses a single Server-Sent Events line from an OpenAI-compatible stream.
 */
export function parseSseLine(line: string): ParsedSseResult | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) {
    return null;
  }
  if (!trimmed.startsWith('data:')) {
    return null;
  }

  const data = trimmed.slice(5).trim();
  if (data === '[DONE]') {
    return { stopReason: 'done' };
  }

  const parsed = JSON.parse(data) as {
    choices?: Array<{
      delta?: { content?: string };
      finish_reason?: string | null;
    }>;
  };
  const choice = parsed.choices?.[0];
  const deltaContent = typeof choice?.delta?.content === 'string' ? choice.delta.content : undefined;
  const finishReason = choice?.finish_reason;

  let stopReason: ParsedSseResult['stopReason'];
  if (finishReason === 'stop') stopReason = 'done';
  else if (finishReason === 'length') stopReason = 'max_tokens';
  else if (typeof finishReason === 'string' && finishReason.length > 0) {
    stopReason = 'stop_sequence';
  }

  return { deltaContent, stopReason };
}

/**
 * Deterministic offline mock text generator ported from `src/inference/mock.rs`,
 * enriched to inspect the assembled prompt and confirm packed pinned rules/memories.
 */
export function generateDeterministicMockReply(
  exactPrompt: string,
  messages: StructuredChatMessage[],
): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? exactPrompt;
  const sysContent = messages.find((m) => m.role === 'system')?.content ?? '';
  const lowerUser = lastUser.toLowerCase();

  const hasPinnedRules = sysContent.includes('[Pinned Instructions & Facts]');
  const hasRetrievedMem = sysContent.includes('[Retrieved Memory]');

  let base: string;
  if (lowerUser.includes('smaller model') || lowerUser.includes('constraint') || lowerUser.includes('context')) {
    base =
      "The model isn't remembering the whole conversation — it only sees the tokens packed into this turn's prompt. As chat history grows, unbudgeted interfaces silently push out earlier constraints.\n\nLowCon separates stored transcript history from active prompt context. Every turn reserves explicit reply space and safety margin first, packs core instructions, pinned rules, and the full user message without silent clipping, then fills remaining budget with scored local memory and newest turns.";
  } else if (lowerUser.includes('rust') || lowerUser.includes('memory')) {
    base =
      'Local memory notes are indexed with BM25 relevance scoring combined with session match, pin boost, and exponential recency decay. Pinned rules are packed independently into the prompt before keyword retrieval so critical constraints are never dropped when wording changes.';
  } else if (lowerUser.includes('offline') || lowerUser.includes('privacy') || lowerUser.includes('vault')) {
    base =
      'LowCon enforces a strict local boundary: remote endpoints are rejected before any request is issued, diagnostic logs scrub sensitive fields before storage, and the local storage vault seals persisted state using AES-256-GCM authenticated encryption derived via PBKDF2-SHA256.';
  } else {
    base = `Received your prompt cleanly within the active context budget. Running deterministic local inference on the loaded model profile with strict token accounting.`;
  }

  const notes: string[] = [];
  if (hasPinnedRules) notes.push('active pinned project rules were verified in the system block');
  if (hasRetrievedMem) notes.push('relevant local memory excerpts were injected');

  if (notes.length > 0) {
    return `${base}\n\nContext verification: ${notes.join(' and ')}.`;
  }
  return base;
}

/**
 * Async non-blocking model fetch against a local OpenAI-compatible server via the loopback proxy.
 */
export async function fetchLocalLmStudioModels(
  rawEndpoint: string,
  logger: DiagnosticLogger,
): Promise<{ ok: true; endpoint: string; models: string[] } | { ok: false; error: string }> {
  const normalized = normalizeApiEndpoint(rawEndpoint);
  if (!isLocalEndpoint(normalized)) {
    const err = `LowCon privacy boundary: Remote endpoint '${normalized}' rejected. Only local loopback addresses (127.0.0.1 / localhost / ::1) are permitted.`;
    logger.warn('inference', err);
    return { ok: false, error: err };
  }

  logger.info('inference', `Testing local server connection at ${normalized}`);
  try {
    const resp = await fetch('/api/local-llm/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: normalized }),
    });
    const data = (await resp.json()) as { endpoint?: string; models?: string[]; error?: string };
    if (!resp.ok) {
      const msg = data.error ?? `HTTP ${resp.status} while querying ${normalized}/models`;
      logger.error('inference', `Model fetch failed: ${msg}`);
      return { ok: false, error: msg };
    }
    const models = Array.isArray(data.models) ? data.models : [];
    logger.info('inference', `Connected to ${normalized}: found ${models.length} model(s)`);
    return { ok: true, endpoint: data.endpoint ?? normalized, models };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('inference', `Network error contacting local proxy: ${msg}`);
    return { ok: false, error: `Failed to reach local server proxy: ${msg}` };
  }
}

function splitIntoStreamTokens(text: string): string[] {
  const tokens: string[] = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if (/\s/.test(ch) || /[.,!?;:]/.test(ch)) {
      tokens.push(buf);
      buf = '';
    }
  }
  if (buf) tokens.push(buf);
  return tokens;
}

/**
 * Manages real worker lifecycle (loading, loaded, generating, cancellation) so UI badges
 * and generation preconditions always reflect actual backend readiness.
 */
export class InferenceController {
  private status: WorkerStatus = { state: 'unloaded' };
  private loadedModel: ModelProfile | null = null;
  private activeAbort: AbortController | null = null;
  private logger: DiagnosticLogger;
  private onStatusChange: (status: WorkerStatus) => void;

  constructor(logger: DiagnosticLogger, onStatusChange: (status: WorkerStatus) => void) {
    this.logger = logger;
    this.onStatusChange = onStatusChange;
  }

  getStatus(): WorkerStatus {
    return this.status;
  }

  getLoadedModel(): ModelProfile | null {
    return this.loadedModel;
  }

  isLoaded(): boolean {
    return this.status.state === 'loaded' || this.status.state === 'generating';
  }

  private setStatus(next: WorkerStatus): void {
    this.status = next;
    this.onStatusChange(next);
  }

  loadModel(profile: ModelProfile): { ok: true } | { ok: false; error: string } {
    this.cancelGeneration();
    this.setStatus({ state: 'loading', modelId: profile.id, modelName: profile.name });

    if (profile.backendType === 'lm_studio' && !isLocalEndpoint(profile.filePath)) {
      const msg = `Privacy boundary rejected non-loopback endpoint '${profile.filePath}'.`;
      this.loadedModel = null;
      this.setStatus({ state: 'error', message: msg });
      this.logger.error('worker', msg);
      return { ok: false, error: msg };
    }

    this.loadedModel = profile;
    const contextLimit = profile.contextOverride ?? profile.contextLimit;
    this.setStatus({
      state: 'loaded',
      modelId: profile.id,
      modelName: profile.name,
      backend: profile.backendType,
      contextLimit,
    });
    this.logger.info(
      'worker',
      `Loaded model '${profile.name}' (backend=${profile.backendType}, context_limit=${contextLimit})`,
    );
    return { ok: true };
  }

  unloadModel(): void {
    this.cancelGeneration();
    const prevName = this.loadedModel?.name;
    this.loadedModel = null;
    this.setStatus({ state: 'unloaded' });
    if (prevName) {
      this.logger.info('worker', `Unloaded model '${prevName}'`);
    }
  }

  cancelGeneration(): void {
    if (this.activeAbort) {
      this.activeAbort.abort();
      this.activeAbort = null;
    }
  }

  async startGeneration(
    sessionId: string,
    params: GenerationParams,
    callbacks: StreamCallbacks,
  ): Promise<void> {
    if (!this.loadedModel || !this.isLoaded()) {
      const msg = 'No model is loaded in the inference worker. Load a model in Models or Settings first.';
      this.logger.error('worker', msg);
      callbacks.onError(msg);
      return;
    }

    const activeModel = this.loadedModel;
    const contextLimit = activeModel.contextOverride ?? activeModel.contextLimit;
    const promptTokens = estimateTokensConservative(params.exactRenderedPrompt);
    if (promptTokens > contextLimit) {
      const msg = `Prompt token estimate (${promptTokens}) exceeds loaded model context limit (${contextLimit}).`;
      this.logger.error('worker', msg);
      callbacks.onError(msg);
      return;
    }

    this.cancelGeneration();
    const abortController = new AbortController();
    this.activeAbort = abortController;
    this.setStatus({
      state: 'generating',
      modelId: activeModel.id,
      modelName: activeModel.name,
      sessionId,
    });

    const restoreLoadedStatus = () => {
      if (this.loadedModel && this.loadedModel.id === activeModel.id) {
        this.setStatus({
          state: 'loaded',
          modelId: activeModel.id,
          modelName: activeModel.name,
          backend: activeModel.backendType,
          contextLimit: activeModel.contextOverride ?? activeModel.contextLimit,
        });
      }
    };

    try {
      if (activeModel.backendType === 'lm_studio') {
        await this.streamFromLmStudio(activeModel, params, abortController.signal, callbacks);
      } else {
        await this.streamFromMock(params, abortController.signal, callbacks);
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        callbacks.onCancelled();
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error('worker', `Inference error: ${msg}`);
        callbacks.onError(msg);
      }
    } finally {
      if (this.activeAbort === abortController) {
        this.activeAbort = null;
      }
      restoreLoadedStatus();
    }
  }

  private async streamFromMock(
    params: GenerationParams,
    signal: AbortSignal,
    callbacks: StreamCallbacks,
  ): Promise<void> {
    const fullReply = generateDeterministicMockReply(
      params.exactRenderedPrompt,
      params.structuredMessages,
    );
    const tokens = splitIntoStreamTokens(fullReply);
    let emitted = 0;
    let stopReason: 'done' | 'max_tokens' | 'stop_sequence' = 'done';

    for (const token of tokens) {
      if (signal.aborted) {
        callbacks.onCancelled();
        return;
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 14);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });

      if (signal.aborted) {
        callbacks.onCancelled();
        return;
      }

      if (params.stopSequences.some((seq) => seq && token.includes(seq))) {
        stopReason = 'stop_sequence';
        break;
      }

      emitted += 1;
      callbacks.onToken(token);

      if (emitted >= params.maxTokens) {
        stopReason = 'max_tokens';
        break;
      }
    }

    callbacks.onComplete(emitted, stopReason);
  }

  private async streamFromLmStudio(
    activeModel: ModelProfile,
    params: GenerationParams,
    signal: AbortSignal,
    callbacks: StreamCallbacks,
  ): Promise<void> {
    const endpoint = normalizeApiEndpoint(params.lmStudioEndpoint || activeModel.filePath);
    if (!isLocalEndpoint(endpoint)) {
      throw new Error(`LowCon privacy boundary rejected remote endpoint '${endpoint}'.`);
    }

    const modelName = params.selectedLmModel?.trim() || activeModel.name;
    this.logger.info(
      'inference',
      `POST ${endpoint}/chat/completions model=${modelName} max_tokens=${params.maxTokens} messages=${params.structuredMessages.length}`,
    );

    const resp = await fetch('/api/local-llm/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint,
        model: modelName,
        messages: params.structuredMessages,
        temperature: params.temperature,
        top_p: params.topP,
        max_tokens: params.maxTokens,
        stop: params.stopSequences,
      }),
      signal,
    });

    if (!resp.ok || !resp.body) {
      const errBody = (await resp.json().catch(() => null)) as { error?: string } | null;
      throw new Error(
        errBody?.error ??
          `Local server at ${endpoint} returned HTTP ${resp.status}. Ensure LM Studio Local Server is running with a model loaded.`,
      );
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalTokens = 0;
    let stopReason: 'done' | 'max_tokens' | 'stop_sequence' = 'done';

    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        callbacks.onCancelled();
        return;
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const parsed = parseSseLine(line);
        if (!parsed) continue;
        if (parsed.deltaContent) {
          totalTokens += 1;
          callbacks.onToken(parsed.deltaContent);
        }
        if (parsed.stopReason) {
          stopReason = parsed.stopReason;
          callbacks.onComplete(totalTokens, stopReason);
          return;
        }
      }
    }

    callbacks.onComplete(totalTokens, stopReason);
  }
}
