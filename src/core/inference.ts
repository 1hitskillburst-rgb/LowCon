import { estimateTokensConservative } from './context';
import { isLocalEndpoint, normalizeApiEndpoint, type DiagnosticLogger } from './privacy';
import {
  CALCULATE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  READ_ATTACHED_CHUNK_TOOL_NAME,
  SAVE_MEMORY_TOOL_NAME,
  SAVE_WORKSPACE_FILE_TOOL_NAME,
  SEARCH_MEMORY_TOOL_NAME,
} from './tier1Tools';
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

function serializeToolArgsValue(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    try {
      return JSON.stringify(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
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
    const serializedArgs = rec.function ? serializeToolArgsValue(rec.function.arguments) : undefined;
    out.push({
      index,
      ...(typeof rec.id === 'string' ? { id: rec.id } : {}),
      ...(typeof rec.type === 'string' ? { type: rec.type } : {}),
      ...(rec.function && typeof rec.function === 'object'
        ? {
            function: {
              ...(typeof rec.function.name === 'string' ? { name: rec.function.name } : {}),
              ...(serializedArgs !== undefined ? { arguments: serializedArgs } : {}),
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
        function_call?: { name?: unknown; arguments?: unknown } | null;
      };
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        reasoning?: string | null;
        tool_calls?: unknown;
        function_call?: { name?: unknown; arguments?: unknown } | null;
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

  let deltaToolCalls = normalizeToolCallChunks(
    choice?.delta?.tool_calls ?? choice?.message?.tool_calls,
  );
  if (!deltaToolCalls) {
    const legacyFn = choice?.delta?.function_call ?? choice?.message?.function_call;
    if (legacyFn && typeof legacyFn === 'object') {
      const legacyArgs = serializeToolArgsValue(legacyFn.arguments);
      if (typeof legacyFn.name === 'string' || legacyArgs !== undefined) {
        deltaToolCalls = [
          {
            index: 0,
            type: 'function',
            function: {
              ...(typeof legacyFn.name === 'string' ? { name: legacyFn.name } : {}),
              ...(legacyArgs !== undefined ? { arguments: legacyArgs } : {}),
            },
          },
        ];
      }
    }
  }

  const finishReason = choice?.finish_reason;

  let stopReason: ParsedSseResult['stopReason'];
  if (finishReason === 'stop') stopReason = 'done';
  else if (finishReason === 'length') stopReason = 'max_tokens';
  else if (finishReason === 'tool_calls' || finishReason === 'function_call') {
    stopReason = 'tool_calls';
  } else if (typeof finishReason === 'string' && finishReason.length > 0) {
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

const KNOWN_WORKSPACE_TOOL_NAMES = new Set<string>([
  CREATE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  CALCULATE_TOOL_NAME,
  READ_ATTACHED_CHUNK_TOOL_NAME,
  SEARCH_MEMORY_TOOL_NAME,
  SAVE_MEMORY_TOOL_NAME,
  SAVE_WORKSPACE_FILE_TOOL_NAME,
]);

function parseTagToolCallPayload(rawJson: string, index: number): ToolCallRecord | null {
  const parsed = parseToolArgumentsJson(rawJson);
  if (!parsed) return null;

  // Support both `{ name, arguments|parameters|args|input }` and `{ function: { name, arguments|parameters } }`
  const fnObj =
    parsed.function && typeof parsed.function === 'object' && !Array.isArray(parsed.function)
      ? (parsed.function as Record<string, unknown>)
      : null;

  const rawName =
    typeof parsed.name === 'string'
      ? parsed.name
      : typeof fnObj?.name === 'string'
        ? fnObj.name
        : typeof parsed.tool === 'string'
          ? parsed.tool
          : '';
  const name = rawName.trim();
  if (!name) return null;

  const rawArgs =
    parsed.arguments ??
    parsed.parameters ??
    parsed.args ??
    parsed.input ??
    fnObj?.arguments ??
    fnObj?.parameters ??
    fnObj?.args;
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
  let activeFnTagBuffer = '';
  let accumulatedVisibleText = '';

  const recordParsedTagTool = (rawPayload: string) => {
    const parsed = parseTagToolCallPayload(rawPayload, tagToolCalls.length);
    if (parsed) {
      tagToolCalls.push(parsed);
      if (!notifiedToolNames.has(parsed.function.name)) {
        notifiedToolNames.add(parsed.function.name);
        callbacks.onToolCallDetected?.(parsed.function.name);
      }
    }
  };

  const fnTagSplitter = new TagBlockSplitter(
    '<function_call>',
    '</function_call>',
    (text) => {
      if (text) {
        emittedContentInChunk = true;
        accumulatedVisibleText += text;
        callbacks.onToken(text);
      }
    },
    (tagInner) => {
      activeFnTagBuffer += tagInner;
    },
    () => {
      const payload = activeFnTagBuffer;
      activeFnTagBuffer = '';
      recordParsedTagTool(payload);
    },
  );

  const toolTagSplitter = new TagBlockSplitter(
    TOOL_CALL_OPEN_TAG,
    TOOL_CALL_CLOSE_TAG,
    (text) => {
      if (text) {
        fnTagSplitter.push(text);
      }
    },
    (tagInner) => {
      activeTagToolBuffer += tagInner;
    },
    () => {
      const payload = activeTagToolBuffer;
      activeTagToolBuffer = '';
      recordParsedTagTool(payload);
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
    fnTagSplitter.flush();
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
    let collectedTools = collectedNative.length > 0 ? collectedNative : tagToolCalls;

    // Fallback: some local models emit a standalone JSON tool call without <tool_call> tags
    if (collectedTools.length === 0 && accumulatedVisibleText.trim()) {
      const trimmedVisible = accumulatedVisibleText
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      if (trimmedVisible.startsWith('{') && trimmedVisible.endsWith('}')) {
        const bareCandidate = parseTagToolCallPayload(trimmedVisible, 0);
        if (bareCandidate && KNOWN_WORKSPACE_TOOL_NAMES.has(bareCandidate.function.name)) {
          collectedTools = [bareCandidate];
        }
      }
    }

    // Preserve tool_calls whenever valid tool calls were emitted — even if llama.cpp /
    // LM Studio ended the turn with finish_reason="stop_sequence" or "eos".
    const hasValidCollectedTools =
      collectedTools.length > 0 &&
      (stopReason !== 'max_tokens' ||
        collectedTools.every((call) => parseToolArgumentsJson(call.function.arguments) !== null));
    const finalReason: StreamStopReason = hasValidCollectedTools ? 'tool_calls' : stopReason;
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
    if (parsed?.status === 'error') {
      const errMsg = typeof parsed.error === 'string' ? parsed.error : 'Unknown tool error.';
      return `The \`${lastMsg.name ?? 'tool'}\` tool reported an error: ${errMsg}`;
    }

    if (lastMsg.name === CALCULATE_TOOL_NAME) {
      const formatted =
        typeof parsed?.formatted === 'string'
          ? parsed.formatted
          : JSON.stringify(parsed?.result ?? '');
      return `Deterministic calculation result: **${formatted}**`;
    }

    if (lastMsg.name === EDIT_FILE_TOOL_NAME) {
      const filename = typeof parsed?.filename === 'string' ? parsed.filename : 'file';
      const linesChanged = typeof parsed?.linesChanged === 'number' ? parsed.linesChanged : 0;
      const totalLines = typeof parsed?.totalLines === 'number' ? parsed.totalLines : 0;
      const previewDiff = typeof parsed?.previewDiff === 'string' ? parsed.previewDiff : '';
      const diffSection = previewDiff ? `\n\n\`\`\`diff\n${previewDiff}\n\`\`\`` : '';
      return `Updated \`${filename}\` (${linesChanged} line(s) changed, ${totalLines} total lines).${diffSection}\n\nOpen the updated file card below to review the changes.`;
    }

    if (lastMsg.name === READ_ATTACHED_CHUNK_TOOL_NAME) {
      const filename = typeof parsed?.filename === 'string' ? parsed.filename : 'attached file';
      const startLine = typeof parsed?.start_line === 'number' ? parsed.start_line : 1;
      const endLine = typeof parsed?.end_line === 'number' ? parsed.end_line : startLine;
      const totalLines = typeof parsed?.total_lines === 'number' ? parsed.total_lines : endLine;
      const hasMore = parsed?.has_more === true;
      const chunkContent = typeof parsed?.content === 'string' ? parsed.content : '';
      const previewLines = chunkContent.split('\n').slice(0, 8).join('\n');
      const snippetBlock = previewLines ? `\n\n\`\`\`text\n${previewLines}\n\`\`\`` : '';
      return `Read \`${filename}\` lines ${startLine}–${endLine} of ${totalLines}${hasMore ? ' (more lines remain)' : ''}.${snippetBlock}`;
    }

    if (lastMsg.name === SEARCH_MEMORY_TOOL_NAME) {
      const query = typeof parsed?.query === 'string' ? parsed.query : '';
      const count = typeof parsed?.count === 'number' ? parsed.count : 0;
      const results = Array.isArray(parsed?.results)
        ? (parsed.results as Array<Record<string, unknown>>)
        : [];
      if (count === 0 || results.length === 0) {
        return `Searched local memory${query ? ` for "${query}"` : ''} and found no matching approved notes.`;
      }
      const bullets = results
        .slice(0, 5)
        .map((r) => {
          const title = typeof r.title === 'string' ? r.title : 'Note';
          const content = typeof r.content === 'string' ? r.content : '';
          return `- **${title}**: ${content}`;
        })
        .join('\n');
      return `Found ${count} matching local memory note${count === 1 ? '' : 's'}${query ? ` for "${query}"` : ''}:\n\n${bullets}`;
    }

    if (lastMsg.name === SAVE_MEMORY_TOOL_NAME) {
      const title = typeof parsed?.title === 'string' ? parsed.title : 'Saved note';
      const isPinned = parsed?.isPinned === true;
      const sourceRef =
        typeof parsed?.sourceReference === 'string' ? parsed.sourceReference : 'Saved via AI tool';
      return `Saved memory note **"${title}"**${isPinned ? ' (pinned to persistent context)' : ''} — ${sourceRef}.`;
    }

    if (lastMsg.name === SAVE_WORKSPACE_FILE_TOOL_NAME) {
      const filename = typeof parsed?.filename === 'string' ? parsed.filename : 'file';
      const action = parsed?.action === 'updated' ? 'Updated' : 'Saved';
      const lines = typeof parsed?.lines === 'number' ? parsed.lines : undefined;
      return `${action} \`${filename}\`${lines ? ` (${lines} lines)` : ''} in the persistent **Files** tab so you can reference it in any chat without re-uploading.`;
    }

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
  const hasCustomSystemPrompt = sysContent.includes('[Custom System Prompt]');
  const profileNameMatch = /The user's name is "([^"]+)"/.exec(sysContent);
  const profileUsername = profileNameMatch?.[1]?.trim();

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
    base = profileUsername
      ? `Hi ${profileUsername} — received your prompt cleanly within the active context budget. Running deterministic local inference on the loaded model profile with strict token accounting.`
      : `Received your prompt cleanly within the active context budget. Running deterministic local inference on the loaded model profile with strict token accounting.`;
  }

  const notes: string[] = [];
  if (hasPinnedRules) notes.push('active pinned project rules were verified in the system block');
  if (hasRetrievedMem) notes.push('relevant local memory excerpts were injected');
  if (hasCustomSystemPrompt) notes.push('your custom system prompt was applied');

  if (notes.length > 0) {
    return `${base}\n\nContext verification: ${notes.join(' and ')}.`;
  }
  return base;
}

function makeMockToolCall(name: string, args: Record<string, unknown>): ToolCallRecord {
  return {
    id: `call_mock_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function findGeneratedFilesInMessages(messages: StructuredChatMessage[]): string[] {
  const filenames: string[] = [];
  const pushUnique = (name: string) => {
    const cleaned = name.trim();
    if (!cleaned) return;
    const idx = filenames.indexOf(cleaned);
    if (idx !== -1) filenames.splice(idx, 1);
    filenames.push(cleaned);
  };

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.function.name === CREATE_FILE_TOOL_NAME || tc.function.name === EDIT_FILE_TOOL_NAME) {
          const parsed = parseToolArgumentsJson(tc.function.arguments);
          if (typeof parsed?.filename === 'string') {
            pushUnique(parsed.filename);
          }
        }
      }
    }
    if (msg.role === 'assistant' && typeof msg.content === 'string') {
      const attachedMatches = msg.content.matchAll(
        /\[(?:Attached|Session) generated files[^:\]]*:\s*([^\]]+)\]/g,
      );
      for (const match of attachedMatches) {
        for (const entry of match[1].split(',')) {
          const name = entry.trim().replace(/\s*\([^)]*\)\s*$/, '').trim();
          if (name) pushUnique(name);
        }
      }
    }
    if (msg.role === 'system' && typeof msg.content === 'string') {
      const filesTabIdx = msg.content.indexOf('[Local Files Tab');
      if (filesTabIdx !== -1) {
        const block = msg.content.slice(filesTabIdx);
        for (const match of block.matchAll(/^- ([^\s(]+)\s*\(/gm)) {
          if (match[1]) pushUnique(match[1]);
        }
      }
    }
    if (msg.role === 'user' && typeof msg.content === 'string') {
      const inlineAttachMatches = msg.content.matchAll(
        /\[Attached local file:\s*([^\]]+)\]/gi,
      );
      for (const match of inlineAttachMatches) {
        if (match[1]) pushUnique(match[1]);
      }
      const indexedAttachMatches = msg.content.matchAll(
        /Attached file:\s*([^\s(]+)\s*\(/gi,
      );
      for (const match of indexedAttachMatches) {
        if (match[1]) pushUnique(match[1]);
      }
    }
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      const parsed = parseToolArgumentsJson(msg.content);
      if (typeof parsed?.filename === 'string' && parsed.status === 'ok') {
        pushUnique(parsed.filename);
      }
    }
  }

  return filenames;
}

function buildMockCommentLineForFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.py') || lower.endsWith('.sh') || lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    return '# Updated via LowCon edit_file tool';
  }
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    return '# Updated Markdown Report';
  }
  if (lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.svg') || lower.endsWith('.xml')) {
    return '<!-- Updated via LowCon edit_file tool -->';
  }
  if (lower.endsWith('.rs')) {
    return '//! Updated via LowCon edit_file tool';
  }
  return '// Updated via LowCon edit_file tool';
}

function extractMathExpressionForMock(instruction: string): string | null {
  const backticked = /`([^`]+)`/.exec(instruction);
  if (backticked?.[1]?.trim()) {
    return backticked[1].trim();
  }
  const stripped = instruction
    .replace(
      /^(?:please\s+)?(?:use\s+calculate(?:\s+tool)?\s*(?:to|on|for|:)?\s*|calculate\s*|compute\s*|evaluate\s*|solve\s*|what\s+is\s*)/i,
      '',
    )
    .replace(/[?.!\s]+$/, '')
    .trim();
  if (!stripped) return null;
  const exprMatch = /[A-Za-z0-9_+\-*/%^().,\s]+/.exec(stripped);
  const candidate = (exprMatch ? exprMatch[0] : stripped).trim();
  return candidate.length > 0 ? candidate : null;
}

function detectMockToolCallRequest(
  messages: StructuredChatMessage[],
  tools?: ToolDefinition[],
): ToolCallRecord | null {
  if (!tools || tools.length === 0) return null;
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role === 'tool') return null;

  const availableNames = new Set(tools.map((t) => t.function.name));
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const attachIdx = lastUser.search(/\n*\[Attached local file/i);
  const userInstruction = (attachIdx >= 0 ? lastUser.slice(0, attachIdx) : lastUser).trim();
  const attachmentSection = attachIdx >= 0 ? lastUser.slice(attachIdx) : '';
  const lower = userInstruction.toLowerCase();

  const explicitFilenameMatch = /\b([a-z0-9_./-]+\.(?:rs|ts|tsx|js|jsx|py|go|cpp|c|html|htm|css|json|sh|yaml|yml|md|markdown|csv|tsv|svg|txt))\b/i.exec(
    userInstruction,
  );
  const knownFiles = findGeneratedFilesInMessages(messages);

  // 0. save_workspace_file (remember/store a file or note in the persistent Files tab)
  const wantsFilesTabSave =
    availableNames.has(SAVE_WORKSPACE_FILE_TOOL_NAME) &&
    (/\b(save_workspace_file)\b/i.test(userInstruction) ||
      /\b(?:save|store|remember|keep|put)\b.*\b(?:to|in)\s+(?:the\s+)?files(?:\s+tab)?\b/i.test(
        userInstruction,
      ) ||
      (/\bremember\s+(?:this|the)\s+file\b/i.test(userInstruction)) ||
      (/\bremember\b/i.test(userInstruction) &&
        (Boolean(attachmentSection) || Boolean(explicitFilenameMatch))));

  if (wantsFilesTabSave) {
    const attachmentNameMatch =
      /filename="([^"]+)"/i.exec(attachmentSection) ??
      /Attached local file:\s*([^\s\]]+)/i.exec(attachmentSection);
    const targetName =
      explicitFilenameMatch?.[1] ??
      attachmentNameMatch?.[1] ??
      knownFiles[knownFiles.length - 1] ??
      'remembered_notes.md';
    const quotedMatch = /[`"]([^`"\n]{4,})[`"]/.exec(userInstruction);
    const colonIdx = userInstruction.indexOf(':');
    const inlineContent =
      colonIdx !== -1 && userInstruction.slice(colonIdx + 1).trim().length > 0
        ? userInstruction.slice(colonIdx + 1).trim()
        : quotedMatch?.[1];
    return makeMockToolCall(SAVE_WORKSPACE_FILE_TOOL_NAME, {
      filename: targetName,
      ...(inlineContent ? { content: inlineContent } : {}),
    });
  }

  // 1. save_memory_note
  if (
    availableNames.has(SAVE_MEMORY_TOOL_NAME) &&
    /\b(save_memory_note|save (?:a |this )?(?:memory )?note|remember that|pin (?:this )?(?:rule|note)(?: to memory)?|save (?:this )?to memory)\b/i.test(
      userInstruction,
    )
  ) {
    const isPinned = /\b(pin|pinned|always keep|project rule)\b/i.test(userInstruction);
    const cleanedBody = userInstruction
      .replace(
        /^(?:please\s+)?(?:call\s+save_memory_note\s*(?:with|for|:)?\s*|save (?:a |this )?(?:memory )?note(?:\s+(?:saying|that|about|:))?\s*|remember that\s*|pin (?:this )?(?:rule|note)(?: to memory)?(?:\s*:|\s+that)?\s*|save (?:this )?to memory(?:\s*:|\s+that)?\s*)/i,
        '',
      )
      .trim();
    const content = cleanedBody || userInstruction.trim() || 'Saved project note';
    const title = content.split(/[:.\n]/)[0]?.trim().slice(0, 48) || 'Saved memory note';
    return makeMockToolCall(SAVE_MEMORY_TOOL_NAME, {
      title,
      content,
      is_pinned: isPinned,
    });
  }

  // 2. search_memory
  if (
    availableNames.has(SEARCH_MEMORY_TOOL_NAME) &&
    /\b(search_memory|search (?:local )?memory|search (?:my )?notes|check memory|look up in memory|recall from memory|find memory notes?)\b/i.test(
      userInstruction,
    )
  ) {
    const cleanedQuery = userInstruction
      .replace(
        /^(?:please\s+)?(?:call\s+search_memory\s*(?:for|with|:)?\s*|search (?:local )?memory(?:\s+(?:for|about))?\s*|search (?:my )?notes(?:\s+(?:for|about))?\s*|check memory(?:\s+(?:for|about))?\s*|look up in memory(?:\s+(?:for|about))?\s*|recall from memory(?:\s+(?:for|about))?\s*|find memory notes?(?:\s+(?:for|about))?\s*)/i,
        '',
      )
      .replace(/[?.!]+$/, '')
      .trim();
    const pinnedOnly = /\bpinned\b/i.test(userInstruction) && !cleanedQuery;
    return makeMockToolCall(SEARCH_MEMORY_TOOL_NAME, {
      query: cleanedQuery || 'memory',
      limit: 5,
      ...(pinnedOnly ? { pinned_only: true } : {}),
    });
  }

  // 3. explicit read_attached_chunk command / line range
  const isIndexedAttachment =
    /\[Attached local file \(?index/i.test(attachmentSection) ||
    /Use read_attached_chunk\(/i.test(attachmentSection);
  const wantsExplicitReadChunk =
    /\b(read_attached_chunk|read chunk|read lines?|inspect lines?|show lines?)\b/i.test(
      userInstruction,
    ) ||
    (isIndexedAttachment && /\blines?\s*\d+(?:\s*(?:-|to|through)\s*\d+)?/i.test(userInstruction));

  const buildReadAttachedChunkCall = (): ToolCallRecord => {
    const filenameMatch =
      /filename="([^"]+)"/i.exec(attachmentSection) ??
      /Attached file:\s*([^\s(]+)/i.exec(attachmentSection) ??
      explicitFilenameMatch;
    const lineRangeMatch = /\blines?\s*(\d+)(?:\s*(?:-|to|through)\s*(\d+))?/i.exec(userInstruction);
    const startLine = lineRangeMatch ? Math.max(1, Number(lineRangeMatch[1])) : 1;
    const endLine = lineRangeMatch?.[2]
      ? Math.max(startLine, Number(lineRangeMatch[2]))
      : startLine + 39;
    return makeMockToolCall(READ_ATTACHED_CHUNK_TOOL_NAME, {
      ...(filenameMatch?.[1] ? { filename: filenameMatch[1] } : {}),
      start_line: startLine,
      end_line: endLine,
    });
  };

  if (availableNames.has(READ_ATTACHED_CHUNK_TOOL_NAME) && wantsExplicitReadChunk) {
    return buildReadAttachedChunkCall();
  }

  // 4. calculate (math, json_validate, regex_test, date_diff)
  if (availableNames.has(CALCULATE_TOOL_NAME)) {
    if (/\b(json_validate|validate json|check json|verify json)\b/i.test(userInstruction)) {
      const objStart = userInstruction.indexOf('{');
      const arrStart = userInstruction.indexOf('[');
      let jsonInput = '{}';
      if (objStart !== -1 && (arrStart === -1 || objStart < arrStart)) {
        const objEnd = userInstruction.lastIndexOf('}');
        if (objEnd > objStart) jsonInput = userInstruction.slice(objStart, objEnd + 1);
      } else if (arrStart !== -1) {
        const arrEnd = userInstruction.lastIndexOf(']');
        if (arrEnd > arrStart) jsonInput = userInstruction.slice(arrStart, arrEnd + 1);
      }
      return makeMockToolCall(CALCULATE_TOOL_NAME, { mode: 'json_validate', input: jsonInput });
    }

    if (/\b(regex_test|test regex|match regex)\b/i.test(userInstruction)) {
      const quoted = [...userInstruction.matchAll(/[`"']([^`"']+)[`"']/g)].map((m) => m[1]);
      return makeMockToolCall(CALCULATE_TOOL_NAME, {
        mode: 'regex_test',
        pattern: quoted[0] ?? '\\d+',
        input: quoted[1] ?? userInstruction,
        flags: 'g',
      });
    }

    if (/\b(date_diff|days between|difference between|how many days)\b/i.test(userInstruction)) {
      const dates = userInstruction.match(/\d{4}-\d{2}-\d{2}(?:T[0-9:.+-Z]+)?/g) ?? [];
      if (dates.length >= 2) {
        return makeMockToolCall(CALCULATE_TOOL_NAME, {
          mode: 'date_diff',
          start_date: dates[0],
          end_date: dates[1],
        });
      }
    }

    const looksLikeFileIntent =
      /\b(create|generate|write|build|make|save|edit|modify|update|patch)\b.*\b(file|script|module|program|\.[a-z0-9]{1,6})\b/i.test(
        userInstruction,
      );
    const sanitizedForMathCheck = userInstruction
      .replace(/\blines?\s*\d+(?:\s*[-–]\s*\d+)?/gi, ' ')
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
    const hasMathOperatorOrFunc =
      /\d+\s*(?:\*\*|[+\-*/%^])\s*\d+|\b(?:sqrt|sin|cos|tan|log|ln|abs|round|floor|ceil|pow|min|max)\s*\(/i.test(
        sanitizedForMathCheck,
      );
    const wantsMath =
      !looksLikeFileIntent &&
      ((/\b(calculate|compute|evaluate|solve)\b/i.test(userInstruction) &&
        (/\d/.test(sanitizedForMathCheck) || hasMathOperatorOrFunc)) ||
        hasMathOperatorOrFunc);
    if (wantsMath) {
      const expr = extractMathExpressionForMock(userInstruction);
      if (expr) {
        return makeMockToolCall(CALCULATE_TOOL_NAME, { mode: 'math', expression: expr });
      }
    }
  }

  // 5. edit_file
  const hasEditVerb = /\b(edit|modify|update|patch|change|replace|fix|refactor)\b/i.test(
    userInstruction,
  );
  const hasFileOrCodeTarget =
    Boolean(explicitFilenameMatch) ||
    /\b(file|script|module|program|code|function|line|lines)\b/i.test(userInstruction);
  const wantsEdit =
    /\b(edit_file)\b/i.test(userInstruction) ||
    (hasEditVerb &&
      (Boolean(explicitFilenameMatch) || (knownFiles.length > 0 && hasFileOrCodeTarget)));

  if (availableNames.has(EDIT_FILE_TOOL_NAME) && wantsEdit) {
    const targetFilename =
      explicitFilenameMatch?.[1] ?? knownFiles[knownFiles.length - 1] ?? 'example.ts';
    const replaceMatch = /\breplace\s+[`"']([^`"']+)[`"']\s+with\s+[`"']([^`"']*)[`"']/i.exec(
      userInstruction,
    );
    if (replaceMatch) {
      return makeMockToolCall(EDIT_FILE_TOOL_NAME, {
        filename: targetFilename,
        old_text: replaceMatch[1],
        new_text: replaceMatch[2],
      });
    }

    const lineRangeMatch = /\blines?\s*(\d+)(?:\s*(?:-|to|through)\s*(\d+))?/i.exec(userInstruction);
    const startLine = lineRangeMatch ? Number(lineRangeMatch[1]) : 1;
    const endLine = lineRangeMatch?.[2] ? Number(lineRangeMatch[2]) : startLine;
    return makeMockToolCall(EDIT_FILE_TOOL_NAME, {
      filename: targetFilename,
      start_line: startLine,
      end_line: Math.max(startLine, endLine),
      replacement: buildMockCommentLineForFilename(targetFilename),
    });
  }

  // 6. implicit indexed attachment chunk read
  if (availableNames.has(READ_ATTACHED_CHUNK_TOOL_NAME) && isIndexedAttachment) {
    return buildReadAttachedChunkCall();
  }

  // 6. create_file
  if (!availableNames.has(CREATE_FILE_TOOL_NAME)) return null;

  const wantsSnippetOnly =
    /\b(example|snippet|one-liner|short code|show me how)\b/.test(lower) &&
    !/\b(file|script|module|program)\b/.test(lower);
  if (wantsSnippetOnly) return null;

  const wantsFile =
    /\b(create|generate|write|build|make|save)\b.*\b(file|script|module|program|report|chart|diagram|widget|table|\.[a-z0-9]{1,8})\b/.test(
      lower,
    ) ||
    /\b[a-z0-9_-]+\.(rs|ts|tsx|js|py|go|cpp|c|html|htm|css|json|sh|yaml|yml|md|markdown|csv|tsv|svg)\b/.test(
      lower,
    );
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
    return makeMockToolCall(CREATE_FILE_TOOL_NAME, {
      filename: 'recursive_linked_list.rs',
      title: 'Recursive linked list',
      language: 'rust',
      content,
    });
  }

  if (lower.includes('.svg') || /\bsvg\b/.test(lower)) {
    return makeMockToolCall(CREATE_FILE_TOOL_NAME, {
      filename: 'context_budget.svg',
      title: 'Context Budget Diagram',
      language: 'svg',
      content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 120" width="360" height="120">
  <rect x="0" y="0" width="360" height="120" rx="10" fill="#F7F8F9" stroke="#D3D8DF" />
  <text x="16" y="28" font-family="sans-serif" font-size="14" font-weight="700" fill="#161B26">LowCon 8K Budget Partition</text>
  <rect x="16" y="46" width="230" height="24" rx="4" fill="#2A3FE0" />
  <rect x="250" y="46" width="64" height="24" rx="4" fill="#1D7A4E" />
  <rect x="318" y="46" width="26" height="24" rx="4" fill="#AAB2BF" />
  <text x="16" y="92" font-family="sans-serif" font-size="11" fill="#444D5C">Prompt (75%) · Reply Reserve (20%) · Safety (5%)</text>
</svg>`,
    });
  }

  if (lower.includes('.csv') || lower.includes('.tsv') || /\b(csv|tsv)\b/.test(lower)) {
    const isTsv = lower.includes('.tsv') || /\btsv\b/.test(lower);
    const sep = isTsv ? '\t' : ',';
    return makeMockToolCall(CREATE_FILE_TOOL_NAME, {
      filename: isTsv ? 'metrics.tsv' : 'metrics.csv',
      title: 'Local Benchmark Metrics',
      language: isTsv ? 'tsv' : 'csv',
      content: [
        ['Profile', 'ContextLimit', 'PromptBudget', 'Status'].join(sep),
        ['Qwen2.5-7B', '8192', '6144', 'Ready'].join(sep),
        ['Llama3-8B', '16384', '12288', 'Verified'].join(sep),
        ['OfflineMock', '131072', '98304', 'Deterministic'].join(sep),
      ].join('\n'),
    });
  }

  if (lower.includes('.html') || lower.includes('.htm') || /\bhtml\b/.test(lower)) {
    return makeMockToolCall(CREATE_FILE_TOOL_NAME, {
      filename: 'widget.html',
      title: 'Budget Calculator Widget',
      language: 'html',
      content: `<!DOCTYPE html>
<html>
<head><title>LowCon Widget</title></head>
<body style="font-family: system-ui, sans-serif; padding: 16px; color: #161B26;">
  <h2 style="margin-top:0;">Context Partition Preview</h2>
  <p id="summary">8192 total tokens · 20% reply reserve</p>
  <button id="btn" style="padding: 6px 12px; border-radius: 6px; border: 1px solid #2A3FE0; background: #2A3FE0; color: #fff; cursor: pointer;">Test 16K</button>
  <script>
    document.getElementById('btn').addEventListener('click', function () {
      document.getElementById('summary').textContent = '16384 total tokens · 12288 prompt budget';
    });
  </script>
</body>
</html>`,
    });
  }

  if (lower.includes('.md') || lower.includes('.markdown') || /\bmarkdown\b/.test(lower)) {
    return makeMockToolCall(CREATE_FILE_TOOL_NAME, {
      filename: 'summary.md',
      title: 'Context Strategy Summary',
      language: 'markdown',
      content: `# LowCon Context Strategy\n\n- **Budget-first assembly:** Reserves output and safety margin before packing history.\n- **Pinned rules:** Always preserved regardless of keyword overlap.\n- **Tier 1 tools:** Safe math, surgical file edits, chunked attachments, and local memory.\n`,
    });
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

  return makeMockToolCall(CREATE_FILE_TOOL_NAME, {
    filename,
    title: isPython ? 'Generated Python script' : 'Generated TypeScript module',
    language,
    content,
  });
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

/**
 * Unloads all loaded models on the local OpenAI-compatible / LM Studio server.
 * Supports `beacon` mode (`navigator.sendBeacon` / `keepalive`) for tab/app exit.
 */
export async function unloadLocalLmModels(
  rawEndpoint: string,
  models: string[],
  options: { beacon?: boolean; logger?: DiagnosticLogger } = {},
): Promise<{ ok: boolean; unloaded?: string[]; error?: string }> {
  const normalized = normalizeApiEndpoint(rawEndpoint);
  if (!isLocalEndpoint(normalized)) {
    const err = `LowCon privacy boundary: Remote endpoint '${normalized}' rejected for unload.`;
    options.logger?.warn('inference', err);
    return { ok: false, error: err };
  }

  const payload = JSON.stringify({
    endpoint: normalized,
    models: models.filter((m) => typeof m === 'string' && m.trim().length > 0),
  });

  if (options.beacon) {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const sent = navigator.sendBeacon(
          '/api/local-llm/unload-all',
          new Blob([payload], { type: 'application/json' }),
        );
        if (sent) {
          return { ok: true };
        }
      }
      void fetch('/api/local-llm/unload-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {});
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  try {
    const resp = await fetch('/api/local-llm/unload-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    const data = (await resp.json().catch(() => ({}))) as {
      ok?: boolean;
      unloaded?: string[];
      error?: string;
    };
    if (!resp.ok) {
      return { ok: false, error: data.error ?? `HTTP ${resp.status}` };
    }
    return { ok: true, unloaded: Array.isArray(data.unloaded) ? data.unloaded : [] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    options.logger?.warn('inference', `Failed to unload local server models: ${msg}`);
    return { ok: false, error: msg };
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
    if (params.tools && params.tools.length > 0 && params.toolChoice !== 'none') {
      const mockToolCall = detectMockToolCallRequest(params.structuredMessages, params.tools);
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

    const respContentType = (resp.headers.get('content-type') ?? '').toLowerCase();
    if (respContentType.includes('application/json')) {
      const rawJsonText = await resp.text();
      const syntheticSse = `data: ${rawJsonText.trim()}\n\ndata: [DONE]\n\n`;
      const encoder = new TextEncoder();
      const singleStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(syntheticSse));
          controller.close();
        },
      });
      await consumeSseStream(singleStream, signal, callbacks);
      return;
    }

    await consumeSseStream(resp.body, signal, callbacks);
  }
}
