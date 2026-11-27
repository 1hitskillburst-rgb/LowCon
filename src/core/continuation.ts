import type { ConversationTurnCandidate } from './context';
import { safeTruncateChars } from './privacy';
import type { PromptInspection } from './types';

export const MAX_AUTO_CONTINUATION_HOPS = 2;
export const THINKING_GUARD_RATIO = 0.7;

/**
 * Computes the actual `max_tokens` to send on a turn:
 * - Keeps `outputReserve` as the guaranteed floor during packing.
 * - When `expandToFreeContext` is true (default), allows the model to use
 *   all remaining unused free context (`outputReserve + remainingCapacity`).
 */
export function computeTurnMaxTokens(
  inspection: Pick<PromptInspection, 'budgetPartition' | 'remainingCapacity'>,
  expandToFreeContext = true,
): number {
  const floor = Math.max(16, Math.floor(inspection.budgetPartition.outputReserve));
  if (!expandToFreeContext) {
    return floor;
  }
  const free = Math.max(0, Math.floor(inspection.remainingCapacity));
  return Math.max(floor, floor + free);
}

/**
 * Condenses long `<think>` reasoning into a compact head+tail excerpt so a
 * Thinking-to-Answer handoff prompt fits comfortably even in 4K windows.
 */
export function summarizeThinkingForHandoff(thinkingContent: string, maxChars = 1600): string {
  const trimmed = thinkingContent.trim();
  if (!trimmed) return '';
  const chars = Array.from(trimmed);
  if (chars.length <= maxChars) {
    return trimmed;
  }
  const headChars = Math.min(400, Math.floor(maxChars * 0.25));
  const tailChars = Math.max(200, maxChars - headChars - 24);
  const head = chars.slice(0, headChars).join('').trimEnd();
  const tail = chars.slice(chars.length - tailChars).join('').trimStart();
  return `${head}\n\n[...earlier reasoning condensed...]\n\n${tail}`;
}

export function buildThinkingHandoffInstruction(thinkingContent: string): string {
  const summary = summarizeThinkingForHandoff(thinkingContent);
  return `[Prior Reasoning Summary]\n${summary}\n\nYour reasoning is complete. Do NOT re-open <think> or re-derive steps from scratch—emit your final answer or required tool call directly now.`;
}

export function buildContinuationInstruction(partialContent: string, tailChars = 1000): string {
  const trimmed = partialContent.trimEnd();
  const chars = Array.from(trimmed);
  const tail =
    chars.length <= tailChars ? trimmed : `...${chars.slice(chars.length - tailChars).join('')}`;
  return `Your previous response stopped at the token limit mid-output. Continue seamlessly from the exact end below without repeating any text, headings, or code already written:\n\n[Already written tail]\n${tail}`;
}

/**
 * Trims any accidental overlap when a continuation pass echoes the trailing
 * phrase or lines of the already-streamed response.
 */
export function dedupeContinuationOverlap(existingContent: string, nextChunk: string): string {
  if (!existingContent || !nextChunk) return nextChunk;
  const maxCheck = Math.min(existingContent.length, nextChunk.length, 240);
  for (let len = maxCheck; len >= 12; len--) {
    const suffix = existingContent.slice(existingContent.length - len);
    if (nextChunk.startsWith(suffix)) {
      return nextChunk.slice(len);
    }
  }
  const existingLines = existingContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const lastLine = existingLines[existingLines.length - 1]?.trim();
  if (lastLine && lastLine.length >= 12) {
    const trimmedNext = nextChunk.trimStart();
    if (trimmedNext.startsWith(lastLine)) {
      const idx = nextChunk.indexOf(lastLine);
      return nextChunk.slice(idx + lastLine.length).replace(/^\r?\n/, '');
    }
  }
  return nextChunk;
}

/**
 * Collapses older `assistant(tool_calls) + tool` turn groups into a single compact
 * summary turn when a multi-round tool session approaches `MANDATORY_EXCEEDS_BUDGET`.
 */
export function distillOlderToolTurns(
  turns: ConversationTurnCandidate[],
  keepRecentGroups = 2,
): ConversationTurnCandidate[] {
  const groupStarts: number[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role === 'assistant' && (turns[i].toolCalls?.length ?? 0) > 0) {
      groupStarts.push(i);
    }
  }
  if (groupStarts.length <= keepRecentGroups) {
    return turns;
  }

  const preserveFromIdx = groupStarts[groupStarts.length - keepRecentGroups];
  const prefix = turns.slice(0, preserveFromIdx);
  const recent = turns.slice(preserveFromIdx);

  const keptNonToolPrefix: ConversationTurnCandidate[] = [];
  const distilledActions: string[] = [];

  for (const turn of prefix) {
    if (turn.role === 'assistant' && turn.toolCalls && turn.toolCalls.length > 0) {
      const names = turn.toolCalls.map((tc) => tc.function.name).join(', ');
      distilledActions.push(names);
    } else if (turn.role === 'tool') {
      const preview = safeTruncateChars(turn.content.replace(/\s+/g, ' ').trim(), 80);
      distilledActions.push(`${turn.name ?? 'tool'} -> ${preview}`);
    } else {
      keptNonToolPrefix.push(turn);
    }
  }

  if (distilledActions.length === 0) {
    return turns;
  }

  return [
    ...keptNonToolPrefix,
    {
      id: 'distilled_tool_history',
      role: 'assistant',
      content: `[Completed earlier tool steps (${distilledActions.length}): ${safeTruncateChars(distilledActions.join(' | '), 500)}]`,
    },
    ...recent,
  ];
}
