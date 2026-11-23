import {
  THEME_COLORS,
  type BudgetPartition,
  type ChatTemplateType,
  type ContextSegment,
  type ContextSegmentKey,
  type ExcludedCandidate,
  type IncludedItem,
  type PromptInspection,
  type SectionTokenBreakdown,
  type StructuredChatMessage,
  type TurnContextBudget,
} from './types';
import { safeTruncateChars } from './privacy';

export interface PinnedFactCandidate {
  id: string;
  title: string;
  content: string;
  sourceReference?: string;
}

export interface TaskStateCandidate {
  goal: string;
  constraints?: string[];
}

export interface MemoryExcerptCandidate {
  id: string;
  title: string;
  excerpt: string;
  sourceMessageId?: string;
  relevanceScore: number;
  isPinned: boolean;
}

export interface SummaryExcerptCandidate {
  id: string;
  sourceTurnRange: string;
  fullText: string;
  compactText: string;
  isPinned: boolean;
}

export interface ConversationTurnCandidate {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isPinned?: boolean;
}

export interface AssemblyCandidates {
  coreInstruction: string;
  currentUserMessage: string;
  currentUserMetadata?: string;
  pinnedFacts: PinnedFactCandidate[];
  taskState?: TaskStateCandidate;
  retrievedMemories: MemoryExcerptCandidate[];
  conversationTurns: ConversationTurnCandidate[];
  summaries: SummaryExcerptCandidate[];
}

export interface AssemblyOptions {
  modelContextLimit: number;
  outputReservePct: number;
  safetyMarginPct: number;
  templateType: ChatTemplateType;
}

export type AssemblyResult =
  | { ok: true; inspection: PromptInspection }
  | { ok: false; code: 'EMPTY_USER_MESSAGE' | 'INVALID_BUDGET' | 'MANDATORY_EXCEEDS_BUDGET'; message: string };

const SPECIAL_TOKEN_PATTERNS = [
  '<|im_start|>',
  '<|im_end|>',
  '<|start_header_id|>',
  '<|end_header_id|>',
  '<|eot_id|>',
  '<|begin_of_text|>',
  '[INST]',
  '[/INST]',
  '<<SYS>>',
  '<</SYS>>',
  '<s>',
  '</s>',
  '<start_of_turn>',
  '<end_of_turn>',
];

function isCjkOrComplex(codePoint: number): boolean {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0x3040 && codePoint <= 0x309f) ||
    (codePoint >= 0x30a0 && codePoint <= 0x30ff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  );
}

/**
 * Conservative token estimator ported faithfully from Rust `ConservativeEstimator`:
 * ~15% safety cushion, CJK/emoji scaling, and special token accounting.
 */
export function estimateTokensConservative(text: string, safetyCushionFactor = 1.15): number {
  if (!text) return 0;

  let rawEstimate = 0;

  for (const pattern of SPECIAL_TOKEN_PATTERNS) {
    let idx = 0;
    while ((idx = text.indexOf(pattern, idx)) !== -1) {
      rawEstimate += 1;
      idx += pattern.length;
    }
  }

  const words = text.trim().split(/\s+/).filter(Boolean);
  for (const word of words) {
    let cjkCount = 0;
    let asciiCount = 0;
    let punctCount = 0;

    for (const ch of word) {
      const cp = ch.codePointAt(0) ?? 0;
      if (isCjkOrComplex(cp)) {
        cjkCount += 1;
      } else if (
        (cp >= 0x30 && cp <= 0x39) ||
        (cp >= 0x41 && cp <= 0x5a) ||
        (cp >= 0x61 && cp <= 0x7a)
      ) {
        asciiCount += 1;
      } else {
        punctCount += 1;
      }
    }

    rawEstimate += cjkCount * 1.5;
    rawEstimate += punctCount;
    if (asciiCount > 0) {
      rawEstimate += Math.ceil(asciiCount / 3.6);
    }
  }

  let newlines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') newlines += 1;
  }
  rawEstimate += newlines * 0.5;

  return Math.max(1, Math.ceil(rawEstimate * Math.max(1.0, safetyCushionFactor)));
}

/**
 * Deterministic budget partition satisfying:
 * promptBudget + outputReserve + safetyMargin <= modelLimit.
 */
export function calculateBudgetPartition(
  modelLimit: number,
  outputReservePct: number,
  safetyMarginPct: number,
): { ok: true; partition: BudgetPartition } | { ok: false; error: string } {
  if (!Number.isFinite(modelLimit) || modelLimit < 256) {
    return { ok: false, error: `Model context limit (${modelLimit}) must be at least 256 tokens.` };
  }
  if (outputReservePct < 1 || safetyMarginPct < 1 || outputReservePct + safetyMarginPct >= 95) {
    return {
      ok: false,
      error: `Invalid reserve percentages (output: ${outputReservePct}%, safety: ${safetyMarginPct}%). Combined reserves must be under 95%.`,
    };
  }

  const outputReserve = Math.max(64, Math.floor((modelLimit * outputReservePct) / 100));
  const safetyMargin = Math.max(32, Math.floor((modelLimit * safetyMarginPct) / 100));
  const promptBudget = Math.max(0, modelLimit - outputReserve - safetyMargin);

  if (promptBudget < 64) {
    return {
      ok: false,
      error: `Remaining prompt budget (${promptBudget} tokens) is too small for context limit ${modelLimit}.`,
    };
  }

  return {
    ok: true,
    partition: {
      modelLimit,
      promptBudget,
      outputReserve,
      safetyMargin,
    },
  };
}

export function renderFullChatTemplate(
  templateType: ChatTemplateType,
  systemContent: string | undefined,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  currentUserContent: string,
): string {
  const sys = systemContent?.trim() ?? '';
  const userTrimmed = currentUserContent.trim();

  switch (templateType) {
    case 'ChatML': {
      let out = '';
      if (sys) out += `<|im_start|>system\n${sys}<|im_end|>\n`;
      for (const h of history) {
        out += `<|im_start|>${h.role}\n${h.content.trim()}<|im_end|>\n`;
      }
      out += `<|im_start|>user\n${userTrimmed}<|im_end|>\n<|im_start|>assistant\n`;
      return out;
    }
    case 'Llama3': {
      let out = '<|begin_of_text|>';
      if (sys) out += `<|start_header_id|>system<|end_header_id|>\n\n${sys}<|eot_id|>`;
      for (const h of history) {
        out += `<|start_header_id|>${h.role}<|end_header_id|>\n\n${h.content.trim()}<|eot_id|>`;
      }
      out += `<|start_header_id|>user<|end_header_id|>\n\n${userTrimmed}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n`;
      return out;
    }
    case 'Llama2': {
      const sysBlock = sys ? `<<SYS>>\n${sys}\n<</SYS>>\n\n` : '';
      if (history.length === 0) {
        return `[INST] ${sysBlock}${userTrimmed} [/INST] `;
      }
      let out = '';
      let firstUser = true;
      for (const h of history) {
        if (h.role === 'user') {
          if (firstUser) {
            out += `[INST] ${sysBlock}${h.content.trim()} [/INST]`;
            firstUser = false;
          } else {
            out += `<s>[INST] ${h.content.trim()} [/INST]`;
          }
        } else {
          out += ` ${h.content.trim()} </s>`;
        }
      }
      out += `<s>[INST] ${userTrimmed} [/INST] `;
      return out;
    }
    case 'Mistral': {
      const sysPrefix = sys ? `System: ${sys}\n\n` : '';
      if (history.length === 0) {
        return `<s>[INST] ${sysPrefix}${userTrimmed} [/INST]`;
      }
      let out = '<s>';
      let firstUser = true;
      for (const h of history) {
        if (h.role === 'user') {
          if (firstUser) {
            out += `[INST] ${sysPrefix}${h.content.trim()} [/INST]`;
            firstUser = false;
          } else {
            out += `[INST] ${h.content.trim()} [/INST]`;
          }
        } else {
          out += ` ${h.content.trim()}</s>`;
        }
      }
      out += `[INST] ${userTrimmed} [/INST]`;
      return out;
    }
    case 'Gemma': {
      let out = '';
      if (sys) out += `<start_of_turn>user\nSystem instructions:\n${sys}<end_of_turn>\n`;
      for (const h of history) {
        const gRole = h.role === 'assistant' ? 'model' : 'user';
        out += `<start_of_turn>${gRole}\n${h.content.trim()}<end_of_turn>\n`;
      }
      out += `<start_of_turn>user\n${userTrimmed}<end_of_turn>\n<start_of_turn>model\n`;
      return out;
    }
    case 'Raw': {
      let out = '';
      if (sys) out += `System: ${sys}\n\n`;
      for (const h of history) {
        const label = h.role === 'assistant' ? 'Assistant' : 'User';
        out += `${label}: ${h.content.trim()}\n\n`;
      }
      out += `User: ${userTrimmed}\n\nAssistant:\n`;
      return out;
    }
  }
}

export function stopSequencesForTemplate(templateType: ChatTemplateType): string[] {
  switch (templateType) {
    case 'ChatML':
      return ['<|im_end|>', '<|endoftext|>'];
    case 'Llama3':
      return ['<|eot_id|>', '<|end_of_text|>'];
    case 'Llama2':
    case 'Mistral':
      return ['</s>'];
    case 'Gemma':
      return ['<end_of_turn>'];
    case 'Raw':
      return ['\nUser:'];
  }
}

function buildSystemText(
  coreInstruction: string,
  pinnedFacts: PinnedFactCandidate[],
  taskState: TaskStateCandidate | undefined,
  memories: MemoryExcerptCandidate[],
  summaries: SummaryExcerptCandidate[],
  useCompactSummaries: boolean,
): string {
  let systemText = coreInstruction.trim();

  if (pinnedFacts.length > 0) {
    systemText += '\n\n[Pinned Instructions & Facts]';
    for (const fact of pinnedFacts) {
      systemText += `\n- ${fact.title}: ${fact.content}`;
    }
  }

  if (taskState && taskState.goal.trim()) {
    systemText += `\n\n[Active Task State]\nGoal: ${taskState.goal.trim()}`;
    if (taskState.constraints && taskState.constraints.length > 0) {
      systemText += `\nConstraints: ${taskState.constraints.join('; ')}`;
    }
  }

  if (memories.length > 0) {
    systemText += '\n\n[Retrieved Memory]';
    for (const mem of memories) {
      const ref = mem.sourceMessageId ? ` [src:${mem.sourceMessageId.slice(0, 8)}]` : '';
      systemText += `\n- ${mem.title}: ${mem.excerpt}${ref}`;
    }
  }

  if (summaries.length > 0) {
    systemText += '\n\n[Earlier History Summaries]';
    for (const sum of summaries) {
      const text = useCompactSummaries ? sum.compactText : sum.fullText;
      systemText += `\n- (Turns ${sum.sourceTurnRange}) ${text}`;
    }
  }

  return systemText;
}

function renderStructuredAndPrompt(
  templateType: ChatTemplateType,
  coreInstruction: string,
  pinnedFacts: PinnedFactCandidate[],
  taskState: TaskStateCandidate | undefined,
  memories: MemoryExcerptCandidate[],
  summaries: SummaryExcerptCandidate[],
  useCompactSummaries: boolean,
  turns: ConversationTurnCandidate[],
  userMessage: string,
  userMetadata: string | undefined,
  includeMetadata: boolean,
): { exactRenderedPrompt: string; structuredMessages: StructuredChatMessage[] } {
  const systemText = buildSystemText(
    coreInstruction,
    pinnedFacts,
    taskState,
    memories,
    summaries,
    useCompactSummaries,
  );

  let finalUserText = userMessage.trim();
  if (includeMetadata && userMetadata?.trim()) {
    finalUserText += `\n[Context Metadata: ${userMetadata.trim()}]`;
  }

  const history = turns.map((t) => ({ role: t.role, content: t.content }));
  const exactRenderedPrompt = renderFullChatTemplate(templateType, systemText, history, finalUserText);

  const structuredMessages: StructuredChatMessage[] = [];
  if (systemText.trim()) {
    structuredMessages.push({ role: 'system', content: systemText });
  }
  for (const h of history) {
    structuredMessages.push({ role: h.role, content: h.content });
  }
  structuredMessages.push({ role: 'user', content: finalUserText });

  return { exactRenderedPrompt, structuredMessages };
}

/**
 * Budget-First Context Assembly Engine.
 * Enforces deterministic priority packing, 4-stage overflow trimming,
 * zero silent clipping of user message/pinned facts, and accurate segment mapping.
 */
export function assembleContext(
  candidates: AssemblyCandidates,
  options: AssemblyOptions,
): AssemblyResult {
  const budgetRes = calculateBudgetPartition(
    options.modelContextLimit,
    options.outputReservePct,
    options.safetyMarginPct,
  );
  if (!budgetRes.ok) {
    return { ok: false, code: 'INVALID_BUDGET', message: budgetRes.error };
  }
  const partition = budgetRes.partition;
  const promptBudget = partition.promptBudget;

  if (!candidates.currentUserMessage.trim()) {
    return { ok: false, code: 'EMPTY_USER_MESSAGE', message: 'Cannot assemble context for an empty user message.' };
  }

  const coreInstruction =
    candidates.coreInstruction.trim() ||
    'You are LowCon, a private, deterministic assistant running on this device.';
  const pinnedFacts = [...candidates.pinnedFacts];
  const taskState = candidates.taskState;
  const workingMemories = [...candidates.retrievedMemories].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return b.relevanceScore - a.relevanceScore;
  });
  const workingTurns = [...candidates.conversationTurns];
  const workingSummaries = [...candidates.summaries];

  let useCompactSummaries = false;
  let includeMetadata = Boolean(candidates.currentUserMetadata?.trim());
  const excludedCandidates: ExcludedCandidate[] = [];

  let rendered = renderStructuredAndPrompt(
    options.templateType,
    coreInstruction,
    pinnedFacts,
    taskState,
    workingMemories,
    workingSummaries,
    useCompactSummaries,
    workingTurns,
    candidates.currentUserMessage,
    candidates.currentUserMetadata,
    includeMetadata,
  );
  let currentTokens = estimateTokensConservative(rendered.exactRenderedPrompt);

  // Stage 1: Drop lowest-ranked unpinned retrieved memory notes
  while (currentTokens > promptBudget) {
    let removeIdx = -1;
    for (let i = workingMemories.length - 1; i >= 0; i--) {
      if (!workingMemories[i].isPinned) {
        removeIdx = i;
        break;
      }
    }
    if (removeIdx === -1) break;

    const [removed] = workingMemories.splice(removeIdx, 1);
    excludedCandidates.push({
      id: removed.id,
      kind: 'retrieved_memory',
      label: `Memory Note: ${removed.title}`,
      estimatedTokens: estimateTokensConservative(`${removed.title}: ${removed.excerpt}`),
      reason: `Trimmed during Stage 1 overflow pass: unpinned memory note (score ${removed.relevanceScore.toFixed(2)}) excluded to fit ${promptBudget} token prompt budget.`,
    });

    rendered = renderStructuredAndPrompt(
      options.templateType,
      coreInstruction,
      pinnedFacts,
      taskState,
      workingMemories,
      workingSummaries,
      useCompactSummaries,
      workingTurns,
      candidates.currentUserMessage,
      candidates.currentUserMetadata,
      includeMetadata,
    );
    currentTokens = estimateTokensConservative(rendered.exactRenderedPrompt);
  }

  // Stage 2: Compact then drop unpinned summaries
  if (currentTokens > promptBudget && workingSummaries.length > 0 && !useCompactSummaries) {
    useCompactSummaries = true;
    rendered = renderStructuredAndPrompt(
      options.templateType,
      coreInstruction,
      pinnedFacts,
      taskState,
      workingMemories,
      workingSummaries,
      useCompactSummaries,
      workingTurns,
      candidates.currentUserMessage,
      candidates.currentUserMetadata,
      includeMetadata,
    );
    currentTokens = estimateTokensConservative(rendered.exactRenderedPrompt);
  }

  while (currentTokens > promptBudget) {
    let removeIdx = -1;
    for (let i = workingSummaries.length - 1; i >= 0; i--) {
      if (!workingSummaries[i].isPinned) {
        removeIdx = i;
        break;
      }
    }
    if (removeIdx === -1) break;

    const [removed] = workingSummaries.splice(removeIdx, 1);
    excludedCandidates.push({
      id: removed.id,
      kind: 'summary',
      label: `Summary (Turns ${removed.sourceTurnRange})`,
      estimatedTokens: estimateTokensConservative(removed.compactText),
      reason: `Trimmed during Stage 2 overflow pass: unpinned summary removed to fit ${promptBudget} token budget.`,
    });

    rendered = renderStructuredAndPrompt(
      options.templateType,
      coreInstruction,
      pinnedFacts,
      taskState,
      workingMemories,
      workingSummaries,
      useCompactSummaries,
      workingTurns,
      candidates.currentUserMessage,
      candidates.currentUserMetadata,
      includeMetadata,
    );
    currentTokens = estimateTokensConservative(rendered.exactRenderedPrompt);
  }

  // Stage 3: Drop oldest unpinned conversation turns
  while (currentTokens > promptBudget) {
    const removeIdx = workingTurns.findIndex((t) => !t.isPinned);
    if (removeIdx === -1) break;

    const [removed] = workingTurns.splice(removeIdx, 1);
    excludedCandidates.push({
      id: removed.id,
      kind: 'conversation_turn',
      label: `Turn (${removed.role}): ${safeTruncateChars(removed.content, 28)}`,
      estimatedTokens: estimateTokensConservative(removed.content),
      reason: `Trimmed during Stage 3 overflow pass: oldest unpinned turn removed to preserve newer turns within ${promptBudget} token budget.`,
    });

    rendered = renderStructuredAndPrompt(
      options.templateType,
      coreInstruction,
      pinnedFacts,
      taskState,
      workingMemories,
      workingSummaries,
      useCompactSummaries,
      workingTurns,
      candidates.currentUserMessage,
      candidates.currentUserMetadata,
      includeMetadata,
    );
    currentTokens = estimateTokensConservative(rendered.exactRenderedPrompt);
  }

  // Stage 4: Strip optional metadata
  if (currentTokens > promptBudget && includeMetadata) {
    includeMetadata = false;
    excludedCandidates.push({
      id: 'metadata',
      kind: 'metadata',
      label: 'Attached Context Metadata',
      estimatedTokens: estimateTokensConservative(candidates.currentUserMetadata ?? ''),
      reason: 'Trimmed during Stage 4 overflow pass: optional metadata stripped to fit prompt budget.',
    });

    rendered = renderStructuredAndPrompt(
      options.templateType,
      coreInstruction,
      pinnedFacts,
      taskState,
      workingMemories,
      workingSummaries,
      useCompactSummaries,
      workingTurns,
      candidates.currentUserMessage,
      candidates.currentUserMetadata,
      includeMetadata,
    );
    currentTokens = estimateTokensConservative(rendered.exactRenderedPrompt);
  }

  // Stage 5: Mandatory Content Verification (NEVER silently clip)
  if (currentTokens > promptBudget) {
    const coreTok = estimateTokensConservative(coreInstruction);
    const userTok = estimateTokensConservative(candidates.currentUserMessage);
    const pinnedTok = pinnedFacts.reduce(
      (sum, f) => sum + estimateTokensConservative(`${f.title}: ${f.content}`),
      0,
    );
    return {
      ok: false,
      code: 'MANDATORY_EXCEEDS_BUDGET',
      message: `Mandatory content requires ${currentTokens} tokens (User message: ${userTok}, Core: ${coreTok}, Pinned rules: ${pinnedTok}), exceeding the ${promptBudget}-token prompt budget (Model limit: ${partition.modelLimit}, Output reserve: ${partition.outputReserve}, Safety margin: ${partition.safetyMargin}). Shorten your message, unpin notes, or increase the context limit in Settings.`,
    };
  }

  // Section breakdown using explicit segmentKey (fixes section-name mismatch bug)
  const sections: SectionTokenBreakdown[] = [];
  const includedItems: IncludedItem[] = [];

  const coreTokens = estimateTokensConservative(coreInstruction);
  sections.push({
    segmentKey: 'core',
    name: 'Core instructions',
    tokens: coreTokens,
    description: 'Always included, compact',
  });
  includedItems.push({
    id: 'core_instruction',
    kind: 'core_instruction',
    label: 'Core system prompt',
    tokens: coreTokens,
  });

  // Pinned rules + active task state -> 'task' segment
  let pinnedAndTaskTokens = 0;
  let pinnedAndTaskParts = 0;
  if (pinnedFacts.length > 0) {
    const pinnedBlock = pinnedFacts.map((f) => `${f.title}: ${f.content}`).join('\n');
    pinnedAndTaskTokens += estimateTokensConservative(pinnedBlock);
    pinnedAndTaskParts += pinnedFacts.length;
    for (const f of pinnedFacts) {
      includedItems.push({
        id: f.id,
        kind: 'pinned_fact',
        label: f.title,
        tokens: estimateTokensConservative(`${f.title}: ${f.content}`),
        sourceRef: f.sourceReference,
      });
    }
  }
  if (taskState && taskState.goal.trim()) {
    const tTok = estimateTokensConservative(taskState.goal);
    pinnedAndTaskTokens += tTok;
    pinnedAndTaskParts += 1;
    includedItems.push({
      id: 'task_state',
      kind: 'task_state',
      label: `Task goal: ${safeTruncateChars(taskState.goal, 40)}`,
      tokens: tTok,
    });
  }
  if (pinnedAndTaskTokens > 0) {
    sections.push({
      segmentKey: 'task',
      name: 'Pinned rules & task state',
      tokens: pinnedAndTaskTokens,
      description: `${pinnedAndTaskParts} pinned rule${pinnedAndTaskParts === 1 ? '' : 's'} / task constraints`,
    });
  }

  // Retrieved memory notes -> 'mem' segment
  if (workingMemories.length > 0) {
    const memBlock = workingMemories.map((m) => `${m.title}: ${m.excerpt}`).join('\n');
    const memTokens = estimateTokensConservative(memBlock);
    sections.push({
      segmentKey: 'mem',
      name: `Retrieved memory (${workingMemories.length})`,
      tokens: memTokens,
      description: `${workingMemories.length} source-linked local note${workingMemories.length === 1 ? '' : 's'}`,
    });
    for (const m of workingMemories) {
      includedItems.push({
        id: m.id,
        kind: 'retrieved_memory',
        label: m.title,
        tokens: estimateTokensConservative(`${m.title}: ${m.excerpt}`),
        sourceRef: m.sourceMessageId,
      });
    }
  }

  // Conversation turns + current user message -> 'recent' segment
  const turnsBlock = workingTurns.map((t) => t.content).join('\n');
  const turnsTokens = workingTurns.length > 0 ? estimateTokensConservative(turnsBlock) : 0;
  const userTokens = estimateTokensConservative(candidates.currentUserMessage);
  const recentTotal = turnsTokens + userTokens;
  sections.push({
    segmentKey: 'recent',
    name: 'Recent turns & prompt',
    tokens: recentTotal,
    description: `${workingTurns.length} prior turn${workingTurns.length === 1 ? '' : 's'} + current message`,
  });
  for (const t of workingTurns) {
    includedItems.push({
      id: t.id,
      kind: 'conversation_turn',
      label: `Turn (${t.role}): ${safeTruncateChars(t.content, 36)}`,
      tokens: estimateTokensConservative(t.content),
    });
  }
  includedItems.push({
    id: 'current_user_message',
    kind: 'current_user_message',
    label: 'Current user message (unclipped)',
    tokens: userTokens,
  });

  // Template syntax overhead -> 'tpl' segment
  const contentSum = sections.reduce((sum, s) => sum + s.tokens, 0);
  const templateOverhead = Math.max(0, currentTokens - contentSum);
  sections.push({
    segmentKey: 'tpl',
    name: 'Chat template',
    tokens: templateOverhead,
    description: `${options.templateType} framing tokens`,
  });

  const remainingCapacity = Math.max(0, promptBudget - currentTokens);
  const includedMemoryIds = [
    ...pinnedFacts.map((f) => f.id),
    ...workingMemories.map((m) => m.id),
  ];

  return {
    ok: true,
    inspection: {
      exactRenderedPrompt: rendered.exactRenderedPrompt,
      structuredMessages: rendered.structuredMessages,
      totalTokens: currentTokens,
      isExactCount: false,
      tokenizerName: 'Conservative Token Estimator (heuristic + 15% cushion)',
      templateType: options.templateType,
      budgetPartition: partition,
      remainingCapacity,
      sections,
      includedItems,
      excludedCandidates,
      includedMemoryIds,
    },
  };
}

const SEGMENT_COLORS: Record<ContextSegmentKey, string> = {
  core: THEME_COLORS.ink,
  task: THEME_COLORS.blue,
  mem: THEME_COLORS.blue2,
  recent: THEME_COLORS.hl,
  tpl: THEME_COLORS.grey,
  free: THEME_COLORS.segFree,
  out: THEME_COLORS.hold,
  safe: THEME_COLORS.hold,
};

/**
 * Converts a PromptInspection directly into UI TurnContextBudget segments
 * using explicit `segmentKey` mapping (zero fragile string matching).
 */
export function buildTurnContextBudget(inspection: PromptInspection): TurnContextBudget {
  const segments: ContextSegment[] = inspection.sections.map((s) => ({
    key: s.segmentKey,
    name: s.name,
    description: s.description,
    tokens: s.tokens,
    color: SEGMENT_COLORS[s.segmentKey],
    isHeld: false,
    isFree: false,
  }));

  segments.push({
    key: 'free',
    name: 'Free',
    description: 'Room for more history or memory',
    tokens: inspection.remainingCapacity,
    color: SEGMENT_COLORS.free,
    isHeld: false,
    isFree: true,
  });

  segments.push({
    key: 'out',
    name: 'Reply space',
    description: 'Reserved for assistant output',
    tokens: inspection.budgetPartition.outputReserve,
    color: SEGMENT_COLORS.out,
    isHeld: true,
    isFree: false,
  });

  segments.push({
    key: 'safe',
    name: 'Safety margin',
    description: 'Buffer against context overflow',
    tokens: inspection.budgetPartition.safetyMargin,
    color: SEGMENT_COLORS.safe,
    isHeld: true,
    isFree: false,
  });

  return {
    totalLimit: inspection.budgetPartition.modelLimit,
    segments,
  };
}

export function getPackedTokens(budget: TurnContextBudget): number {
  return budget.segments
    .filter((s) => !s.isFree && !s.isHeld)
    .reduce((sum, s) => sum + s.tokens, 0);
}

export function getFreeTokens(budget: TurnContextBudget): number {
  return budget.segments.find((s) => s.key === 'free')?.tokens ?? 0;
}

export function getPackedPercentage(budget: TurnContextBudget): number {
  if (budget.totalLimit <= 0) return 0;
  return (getPackedTokens(budget) / budget.totalLimit) * 100;
}
