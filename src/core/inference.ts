import { estimateTokensConservative } from './context';
import { isLocalEndpoint, normalizeApiEndpoint, type DiagnosticLogger } from './privacy';
import { CREATE_FILE_TOOL_NAME, parseToolArgumentsJson } from './tools';
import type {
  EffortLevel,
  ModelProfile,
  StructuredChatMessage,
  ToolCallRecord,
  ToolDefinition,
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
  reasoningEffort?: EffortLevel;
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required';
}

export interface GenerationProgress {
  totalTokens: number;
  tokensPerSecond: number;
  isThinking: boolean;
}

export type StreamStopReason = 'done' | 'max_tokens' | 'stop_sequence' | 'tool_calls';

export type StreamCallbacks = {
  onToken: (token: string) => void;
  onThinkingToken?: (token: string) => void;
  onToolCallDetected?: (toolName: string) => void;
  onProgress?: (progress: GenerationProgress) => void;
  onComplete: (
    totalTokens: number,
    stopReason: StreamStopReason,
    stats?: { tokensPerSecond: number; toolCalls?: ToolCallRecord[] },
  ) => void;
  onCancelled: () => void;
  onError: (message: string) => void;
};

export interface DeltaToolCallChunk {
  index: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface ParsedSseResult {
  deltaContent?: string;
  deltaThinking?: string;
  deltaToolCalls?: DeltaToolCallChunk[];
  stopReason?: StreamStopReason;
  usageCompletionTokens?: number;
  error?: string;
}

function normalizeToolCallChunks(raw: unknown): DeltaToolCallChunk[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: DeltaToolCallChunk[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;
    const rec = item as {
      index?: unknown;
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const index =
      typeof rec.index === 'number' && Number.isInteger(rec.index) && rec.index >= 0
        ? rec.index
        : i;
    out.push({
      index,
      ...(typeof rec.id === 'string' ? { id: rec.id } : {}),
      ...(typeof rec.type === 'string' ? { type: rec.type } : {}),
      ...(rec.function && typeof rec.function === 'object'
        ? {
            function: {
              ...(typeof rec.function.name === 'string' ? { name: rec.function.name } : {}),
              ...(typeof rec.function.arguments === 'string'
                ? { arguments: rec.function.arguments }
                : {}),
            },
          }
        : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Parses a single Server-Sent Events line from an OpenAI-compatible stream.
 * Supports standard `delta.content`, `delta.tool_calls`, reasoning fields
 * (`reasoning_content` / `reasoning`), usage/timing token counts, and inline `error` payloads.
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
    error?: string | { message?: string };
    usage?: { completion_tokens?: number };
    timings?: { predicted_n?: number };
    choices?: Array<{
      delta?: {
        content?: string | null;
        reasoning_content?: string | null;
        reasoning?: string | null;
        tool_calls?: unknown;
      };
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        reasoning?: string | null;
        tool_calls?: unknown;
      };
      finish_reason?: string | null;
    }>;
  };

  if (parsed.error) {
    const errorMsg =
      typeof parsed.error === 'string'
        ? parsed.error
        : parsed.error.message?.trim() || 'Local inference server returned a stream error.';
    return { error: errorMsg };
  }

  const choice = parsed.choices?.[0];
  const rawContent = choice?.delta?.content ?? choice?.message?.content;
  const deltaContent = typeof rawContent === 'string' ? rawContent : undefined;

  const rawThinking =
    choice?.delta?.reasoning_content ??
    choice?.delta?.reasoning ??
    choice?.message?.reasoning_content ??
    choice?.message?.reasoning;
  const deltaThinking = typeof rawThinking === 'string' ? rawThinking : undefined;

  const deltaToolCalls = normalizeToolCallChunks(
    choice?.delta?.tool_calls ?? choice?.message?.tool_calls,
  );

  const finishReason = choice?.finish_reason;

  let stopReason: ParsedSseResult['stopReason'];
  if (finishReason === 'stop') stopReason = 'done';
  else if (finishReason === 'length') stopReason = 'max_tokens';
  else if (finishReason === 'tool_calls') stopReason = 'tool_calls';
  else if (typeof finishReason === 'string' && finishReason.length > 0) {
    stopReason = 'stop_sequence';
  }

  const rawUsage = parsed.usage?.completion_tokens ?? parsed.timings?.predicted_n;
  const usageCompletionTokens =
    typeof rawUsage === 'number' && Number.isFinite(rawUsage) && rawUsage > 0
      ? Math.round(rawUsage)
      : undefined;

  const result: ParsedSseResult = { deltaContent, stopReason };
  if (deltaThinking !== undefined) {
    result.deltaThinking = deltaThinking;
  }
  if (deltaToolCalls !== undefined) {
    result.deltaToolCalls = deltaToolCalls;
  }
  if (usageCompletionTokens !== undefined) {
    result.usageCompletionTokens = usageCompletionTokens;
  }
  return result;
}

const THINK_OPEN_TAG = '<think>';
const THINK_CLOSE_TAG = '</think>';
const TOOL_CALL_OPEN_TAG = '<tool_call>';
const TOOL_CALL_CLOSE_TAG = '</tool_call>';

function trailingTagPrefixLength(text: string, tag: string): number {
  const lower = text.toLowerCase();
  const maxCheck = Math.min(lower.length, tag.length - 1);
  for (let len = maxCheck; len >= 1; len--) {
    if (lower.endsWith(tag.slice(0, len))) {
      return len;
    }
  }
  return 0;
}

/**
 * Stateful splitter for inline `<tag>...</tag>` blocks split across arbitrary stream chunks.
 */
class TagBlockSplitter {
  private inside = false;
  private pending = '';
  private openTag: string;
  private closeTag: string;
  private onOutside: (text: string) => void;
  private onInside: (text: string) => void;
  private onCloseBlock?: () => void;

  constructor(
    openTag: string,
    closeTag: string,
    onOutside: (text: string) => void,
    onInside: (text: string) => void,
    onCloseBlock?: () => void,
  ) {
    this.openTag = openTag.toLowerCase();
    this.closeTag = closeTag.toLowerCase();
    this.onOutside = onOutside;
    this.onInside = onInside;
    this.onCloseBlock = onCloseBlock;
  }

  isInside(): boolean {
    return this.inside;
  }

  push(chunk: string): void {
    if (!chunk) return;
    this.pending += chunk;

    while (this.pending.length > 0) {
      if (!this.inside) {
        const idx = this.pending.toLowerCase().indexOf(this.openTag);
        if (idx !== -1) {
          if (idx > 0) {
            this.onOutside(this.pending.slice(0, idx));
          }
          this.pending = this.pending.slice(idx + this.openTag.length);
          this.inside = true;
          continue;
        }
        const hold = trailingTagPrefixLength(this.pending, this.openTag);
        const emitLen = this.pending.length - hold;
        if (emitLen > 0) {
          this.onOutside(this.pending.slice(0, emitLen));
          this.pending = this.pending.slice(emitLen);
        }
        break;
      } else {
        const idx = this.pending.toLowerCase().indexOf(this.closeTag);
        if (idx !== -1) {
          if (idx > 0) {
            this.onInside(this.pending.slice(0, idx));
          }
          this.pending = this.pending.slice(idx + this.closeTag.length);
          this.inside = false;
          this.onCloseBlock?.();
          continue;
        }
        const hold = trailingTagPrefixLength(this.pending, this.closeTag);
        const emitLen = this.pending.length - hold;
        if (emitLen > 0) {
          this.onInside(this.pending.slice(0, emitLen));
          this.pending = this.pending.slice(emitLen);
        }
        break;
      }
    }
  }

  flush(): void {
    if (!this.pending) return;
    if (this.inside) {
      this.onInside(this.pending);
      this.onCloseBlock?.();
    } else {
      this.onOutside(this.pending);
    }
    this.pending = '';
  }
}

function parseTagToolCallPayload(rawJson: string, index: number): ToolCallRecord | null {
  const parsed = parseToolArgumentsJson(rawJson);
  if (!parsed) return null;
  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
  if (!name) return null;

  const rawArgs = parsed.arguments;
  let serializedArgs = '{}';
  if (typeof rawArgs === 'string') {
    serializedArgs = rawArgs;
  } else if (rawArgs && typeof rawArgs === 'object') {
    serializedArgs = JSON.stringify(rawArgs);
  }

  return {
    id: `call_tag_${index}_${Date.now().toString(36)}`,
    type: 'function',
    function: {
      name,
      arguments: serializedArgs,
    },
  };
}

/**
 * Consumes an OpenAI-compatible SSE ReadableStream, flushing any trailing
 * decoder bytes and buffered line data if the stream closes without a newline.
 */
export async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  callbacks: StreamCallbacks,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const startedAt = performance.now();
  let buffer = '';
  let streamedDeltas = 0;
  let latestUsageTokens: number | undefined;
  let stopReason: StreamStopReason = 'done';

  let emittedThinkingInChunk = false;
  let emittedContentInChunk = false;

  const nativeToolCalls = new Map<number, ToolCallRecord>();
  const notifiedToolNames = new Set<string>();
  const tagToolCalls: ToolCallRecord[] = [];
  let activeTagToolBuffer = '';

  const toolTagSplitter = new TagBlockSplitter(
    TOOL_CALL_OPEN_TAG,
    TOOL_CALL_CLOSE_TAG,
    (text) => {
      if (text) {
        emittedContentInChunk = true;
        callbacks.onToken(text);
      }
    },
    (tagInner) => {
      activeTagToolBuffer += tagInner;
    },
    () => {
      const parsed = parseTagToolCallPayload(activeTagToolBuffer, tagToolCalls.length);
      activeTagToolBuffer = '';
      if (parsed) {
        tagToolCalls.push(parsed);
        if (!notifiedToolNames.has(parsed.function.name)) {
          notifiedToolNames.add(parsed.function.name);
          callbacks.onToolCallDetected?.(parsed.function.name);
        }
      }
    },
  );

  const thinkSplitter = new TagBlockSplitter(
    THINK_OPEN_TAG,
    THINK_CLOSE_TAG,
    (text) => {
      if (text) {
        toolTagSplitter.push(text);
      }
    },
    (text) => {
      if (text) {
        emittedThinkingInChunk = true;
        callbacks.onThinkingToken?.(text);
      }
    },
  );

  const calcTokensPerSecond = (tokens: number): number => {
    if (tokens <= 0) return 0;
    const elapsedSecs = Math.max(0.05, (performance.now() - startedAt) / 1000);
    return Number((tokens / elapsedSecs).toFixed(1));
  };

  const mergeToolCallChunks = (chunks: DeltaToolCallChunk[]) => {
    for (const chunk of chunks) {
      const existing = nativeToolCalls.get(chunk.index) ?? {
        id: chunk.id || `call_${chunk.index}_${Date.now().toString(36)}`,
        type: 'function' as const,
        function: { name: '', arguments: '' },
      };
      if (chunk.id) existing.id = chunk.id;
      if (chunk.function?.name) {
        existing.function.name += chunk.function.name;
        const cleanName = existing.function.name.trim();
        if (cleanName && !notifiedToolNames.has(cleanName)) {
          notifiedToolNames.add(cleanName);
          callbacks.onToolCallDetected?.(cleanName);
        }
      }
      if (chunk.function?.arguments) {
        existing.function.arguments += chunk.function.arguments;
      }
      nativeToolCalls.set(chunk.index, existing);
    }
  };

  const finalizeAndComplete = () => {
    thinkSplitter.flush();
    toolTagSplitter.flush();
    const collectedNative = [...nativeToolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => ({
        ...call,
        function: {
          name: call.function.name.trim(),
          arguments: call.function.arguments,
        },
      }))
      .filter((call) => call.function.name.length > 0);
    const collectedTools = collectedNative.length > 0 ? collectedNative : tagToolCalls;
    const finalReason: StreamStopReason =
      collectedTools.length > 0 && (stopReason === 'done' || stopReason === 'tool_calls')
        ? 'tool_calls'
        : stopReason;
    const finalTokens = latestUsageTokens ?? streamedDeltas;
    callbacks.onComplete(finalTokens, finalReason, {
      tokensPerSecond: calcTokensPerSecond(finalTokens),
      ...(collectedTools.length > 0 ? { toolCalls: collectedTools } : {}),
    });
  };

  const processLines = (lines: string[]): 'done' | 'error' | null => {
    for (const line of lines) {
      const parsed = parseSseLine(line);
      if (!parsed) continue;

      if (parsed.error) {
        thinkSplitter.flush();
        toolTagSplitter.flush();
        callbacks.onError(parsed.error);
        return 'error';
      }

      if (parsed.usageCompletionTokens !== undefined) {
        latestUsageTokens = parsed.usageCompletionTokens;
      }

      emittedThinkingInChunk = false;
      emittedContentInChunk = false;
      const hadPayload =
        (parsed.deltaThinking && parsed.deltaThinking.length > 0) ||
        (parsed.deltaContent && parsed.deltaContent.length > 0) ||
        (parsed.deltaToolCalls && parsed.deltaToolCalls.length > 0);

      if (parsed.deltaThinking) {
        emittedThinkingInChunk = true;
        callbacks.onThinkingToken?.(parsed.deltaThinking);
      }

      if (parsed.deltaContent) {
        thinkSplitter.push(parsed.deltaContent);
      }

      if (parsed.deltaToolCalls) {
        mergeToolCallChunks(parsed.deltaToolCalls);
      }

      if (hadPayload) {
        streamedDeltas += 1;
        const currentTotal = latestUsageTokens ?? streamedDeltas;
        callbacks.onProgress?.({
          totalTokens: currentTotal,
          tokensPerSecond: calcTokensPerSecond(currentTotal),
          isThinking:
            thinkSplitter.isInside() || (emittedThinkingInChunk && !emittedContentInChunk),
        });
      }

      if (parsed.stopReason) {
        stopReason = parsed.stopReason;
        finalizeAndComplete();
        return 'done';
      }
    }
    return null;
  };

  while (true) {
    if (signal.aborted) {
      await reader.cancel().catch(() => {});
      callbacks.onCancelled();
      return;
    }

    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    const outcome = processLines(lines);
    if (outcome) {
      return;
    }
  }

  if (buffer.trim()) {
    const outcome = processLines(buffer.split('\n'));
    if (outcome) {
      return;
    }
  }

  finalizeAndComplete();
}

/**
 * Deterministic offline mock text generator ported from `src/inference/mock.rs`,
 * enriched to inspect the assembled prompt and confirm packed pinned rules/memories.
 */
export function generateDeterministicMockReply(
  exactPrompt: string,
  messages: StructuredChatMessage[],
): string {
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === 'tool') {
    const parsed = parseToolArgumentsJson(lastMsg.content ?? '');
    const filename = typeof parsed?.filename === 'string' ? parsed.filename : 'generated_file';
    const lines = typeof parsed?.lines === 'number' ? parsed.lines : undefined;
    const language = typeof parsed?.language === 'string' ? parsed.language : 'code';
    const lineNote = lines ? ` (${lines} lines)` : '';
    return `I've created \`${filename}\`${lineNote} and attached it as a preview card below so you can inspect, copy, or download the ${language} file without cluttering the chat.\n\nClick the file card at the bottom of this message to open the right-side preview drawer.`;
  }

  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? exactPrompt;
  const sysContent = messages.find((m) => m.role === 'system')?.content ?? '';
  const lowerUser = (lastUser ?? '').toLowerCase();

  const hasPinnedRules = sysContent.includes('[Pinned Instructions & Facts]');
  const hasRetrievedMem = sysContent.includes('[Retrieved Memory]');

  let base: string;
  if (
    lowerUser.includes('example') ||
    lowerUser.includes('snippet') ||
    lowerUser.includes('show me how')
  ) {
    base =
      'Here is a concise inline snippet example (kept in chat rather than creating a standalone file):\n\n```rust\nfn factorial(n: u64) -> u64 {\n    match n {\n        0 | 1 => 1,\n        _ => n * factorial(n - 1),\n    }\n}\n```';
  } else if (lowerUser.includes('smaller model') || lowerUser.includes('constraint') || lowerUser.includes('context')) {
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

function detectMockFileGenerationRequest(
  messages: StructuredChatMessage[],
): ToolCallRecord | null {
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role === 'tool') return null;

  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const lower = lastUser.toLowerCase();

  const wantsSnippetOnly =
    /\b(example|snippet|one-liner|short code|show me how)\b/.test(lower) &&
    !/\b(file|script|module|program)\b/.test(lower);
  if (wantsSnippetOnly) return null;

  const wantsFile =
    /\b(create|generate|write|build|make|save)\b.*\b(file|script|module|program|\.[a-z0-9]{1,6})\b/.test(
      lower,
    ) || /\b[a-z0-9_-]+\.(rs|ts|tsx|js|py|go|cpp|c|html|css|json|sh|yaml)\b/.test(lower);
  if (!wantsFile) return null;

  if (lower.includes('rust') || lower.includes('.rs')) {
    const content = `//! A singly linked list where the \`Node<T>\` methods do the work recursively.
//!
//! Run the demo:  rustc recursive_linked_list.rs && ./recursive_linked_list
//! Run the tests: rustc --test recursive_linked_list.rs && ./recursive_linked_list

use std::fmt;

type Link<T> = Option<Box<Node<T>>>;

#[derive(Debug)]
struct Node<T> {
    value: T,
    next: Link<T>,
}

impl<T> Node<T> {
    fn new(value: T) -> Self {
        Node { value, next: None }
    }

    /// Recursively walk to the tail and attach a new node.
    fn push_back(&mut self, value: T) {
        match &mut self.next {
            Some(next) => next.push_back(value),
            None => self.next = Some(Box::new(Node::new(value))),
        }
    }

    /// Length of the chain starting at this node.
    fn len(&self) -> usize {
        1 + self.next.as_ref().map_or(0, |n| n.len())
    }

    /// Borrow the value \`index\` nodes further down the chain.
    fn get(&self, index: usize) -> Option<&T> {
        if index == 0 {
            Some(&self.value)
        } else {
            self.next.as_ref()?.get(index - 1)
        }
    }
}

#[derive(Debug, Default)]
pub struct List<T> {
    head: Link<T>,
}

impl<T> List<T> {
    pub fn new() -> Self {
        List { head: None }
    }

    pub fn push_back(&mut self, value: T) {
        match &mut self.head {
            Some(head) => head.push_back(value),
            None => self.head = Some(Box::new(Node::new(value))),
        }
    }

    pub fn len(&self) -> usize {
        self.head.as_ref().map_or(0, |n| n.len())
    }

    pub fn is_empty(&self) -> bool {
        self.head.is_none()
    }

    pub fn get(&self, index: usize) -> Option<&T> {
        self.head.as_ref()?.get(index)
    }
}

impl<T: fmt::Display> fmt::Display for List<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[")?;
        let mut cur = self.head.as_ref();
        while let Some(node) = cur {
            write!(f, "{}", node.value)?;
            if node.next.is_some() {
                write!(f, " -> ")?;
            }
            cur = node.next.as_ref();
        }
        write!(f, "]")
    }
}

fn main() {
    let mut list = List::new();
    list.push_back(1);
    list.push_back(2);
    list.push_back(3);
    println!("List: {} (len={})", list, list.len());
}
`;
    return {
      id: `call_mock_${Date.now().toString(36)}`,
      type: 'function',
      function: {
        name: CREATE_FILE_TOOL_NAME,
        arguments: JSON.stringify({
          filename: 'recursive_linked_list.rs',
          title: 'Recursive linked list',
          language: 'rust',
          content,
        }),
      },
    };
  }

  const isPython = lower.includes('python') || lower.includes('.py');
  const filename = isPython ? 'script.py' : 'example.ts';
  const language = isPython ? 'python' : 'typescript';
  const content = isPython
    ? `#!/usr/bin/env python3
"""Generated local Python script."""


def main() -> None:
    print("Hello from LowCon generated file!")


if __name__ == "__main__":
    main()
`
    : `export function greetLocal(name: string): string {
  return \`Hello from \${name}!\`;
}

console.log(greetLocal('LowCon'));
`;

  return {
    id: `call_mock_${Date.now().toString(36)}`,
    type: 'function',
    function: {
      name: CREATE_FILE_TOOL_NAME,
      arguments: JSON.stringify({
        filename,
        title: isPython ? 'Generated Python script' : 'Generated TypeScript module',
        language,
        content,
      }),
    },
  };
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
    const toolsTokens =
      params.tools && params.tools.length > 0
        ? estimateTokensConservative(JSON.stringify(params.tools))
        : 0;
    const promptTokens = estimateTokensConservative(params.exactRenderedPrompt) + toolsTokens;
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
    const hasCreateFileTool = params.tools?.some(
      (t) => t.function.name === CREATE_FILE_TOOL_NAME,
    );
    if (hasCreateFileTool) {
      const mockToolCall = detectMockFileGenerationRequest(params.structuredMessages);
      if (mockToolCall) {
        callbacks.onToolCallDetected?.(mockToolCall.function.name);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 120);
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
        callbacks.onComplete(18, 'tool_calls', {
          tokensPerSecond: 45,
          toolCalls: [mockToolCall],
        });
        return;
      }
    }

    const fullReply = generateDeterministicMockReply(
      params.exactRenderedPrompt,
      params.structuredMessages,
    );
    const tokens = splitIntoStreamTokens(fullReply);
    const startedAt = performance.now();
    let emitted = 0;
    let stopReason: StreamStopReason = 'done';

    const calcTps = (count: number): number => {
      if (count <= 0) return 0;
      const elapsedSecs = Math.max(0.05, (performance.now() - startedAt) / 1000);
      return Number((count / elapsedSecs).toFixed(1));
    };

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
      callbacks.onProgress?.({
        totalTokens: emitted,
        tokensPerSecond: calcTps(emitted),
        isThinking: false,
      });

      if (emitted >= params.maxTokens) {
        stopReason = 'max_tokens';
        break;
      }
    }

    callbacks.onComplete(emitted, stopReason, { tokensPerSecond: calcTps(emitted) });
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
      `POST ${endpoint}/chat/completions model=${modelName} max_tokens=${params.maxTokens} messages=${params.structuredMessages.length}${params.reasoningEffort ? ` reasoning_effort=${params.reasoningEffort}` : ''}`,
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
        ...(params.reasoningEffort ? { reasoning_effort: params.reasoningEffort } : {}),
        ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
        ...(params.tools && params.tools.length > 0 && params.toolChoice
          ? { tool_choice: params.toolChoice }
          : {}),
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

    await consumeSseStream(resp.body, signal, callbacks);
  }
}
