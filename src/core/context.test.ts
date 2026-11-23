import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleContext,
  buildTurnContextBudget,
  calculateBudgetPartition,
  estimateTokensConservative,
  getPackedTokens,
} from './context';

test('budget partition enforces prompt + output + safety <= limit across 2K..32K', () => {
  for (const limit of [2048, 4096, 8192, 16384, 32768]) {
    const res = calculateBudgetPartition(limit, 20, 5);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.ok(
        res.partition.promptBudget + res.partition.outputReserve + res.partition.safetyMargin <=
          limit,
      );
      assert.equal(res.partition.modelLimit, limit);
    }
  }
});

test('custom user reserve percentages are respected instead of hardcoded defaults', () => {
  const res = calculateBudgetPartition(4096, 30, 10);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.partition.outputReserve, Math.floor(4096 * 0.3));
    assert.equal(res.partition.safetyMargin, Math.floor(4096 * 0.1));
  }
});

test('mandatory user message exceeding budget returns explicit error and never silently clips', () => {
  const hugePrompt = 'constraint '.repeat(1200);
  const res = assembleContext(
    {
      coreInstruction: 'You are LowCon.',
      currentUserMessage: hugePrompt,
      pinnedFacts: [],
      retrievedMemories: [],
      conversationTurns: [],
      summaries: [],
    },
    {
      modelContextLimit: 512,
      outputReservePct: 20,
      safetyMarginPct: 5,
      templateType: 'ChatML',
    },
  );
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, 'MANDATORY_EXCEEDS_BUDGET');
    assert.ok(res.message.includes('Mandatory content requires'));
  }
});

test('deterministic 4-stage overflow trimming drops memories then turns while preserving pinned facts', () => {
  const res = assembleContext(
    {
      coreInstruction: 'You are LowCon.',
      currentUserMessage: 'Summarize the latest plan.',
      pinnedFacts: [
        {
          id: 'pin-1',
          title: 'Invariant Rule',
          content: 'Never drop pinned rules during trimming.',
        },
      ],
      retrievedMemories: [
        {
          id: 'mem-low',
          title: 'Low Priority Note',
          excerpt: 'background detail '.repeat(120),
          relevanceScore: 0.2,
          isPinned: false,
        },
      ],
      conversationTurns: [
        {
          id: 'turn-old',
          role: 'user',
          content: 'old history '.repeat(120),
        },
        {
          id: 'turn-new',
          role: 'assistant',
          content: 'Recent turn answer.',
        },
      ],
      summaries: [],
    },
    {
      modelContextLimit: 512,
      outputReservePct: 20,
      safetyMarginPct: 5,
      templateType: 'ChatML',
    },
  );

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.ok(res.inspection.totalTokens <= res.inspection.budgetPartition.promptBudget);
    assert.ok(res.inspection.exactRenderedPrompt.includes('Never drop pinned rules'));
    assert.ok(res.inspection.exactRenderedPrompt.includes('Summarize the latest plan.'));
    assert.ok(res.inspection.excludedCandidates.some((e) => e.id === 'mem-low'));
    assert.ok(res.inspection.excludedCandidates.some((e) => e.id === 'turn-old'));

    // Structured messages do NOT contain raw ChatML tags (fixes LM Studio double-templating bug)
    for (const msg of res.inspection.structuredMessages) {
      assert.equal(msg.content.includes('<|im_start|>'), false);
    }

    // Section-to-segment key mapping preserves distinct keys (fixes collapsed Core bug)
    const budget = buildTurnContextBudget(res.inspection);
    const keys = new Set(budget.segments.map((s) => s.key));
    assert.ok(keys.has('core'));
    assert.ok(keys.has('task'));
    assert.ok(keys.has('recent'));
    assert.ok(keys.has('tpl'));
    assert.ok(keys.has('free'));
    assert.ok(keys.has('out'));
    assert.ok(keys.has('safe'));
    assert.equal(getPackedTokens(budget), res.inspection.totalTokens);
  }
});

test('conservative estimator scales CJK text and handles empty input', () => {
  assert.equal(estimateTokensConservative(''), 0);
  assert.ok(estimateTokensConservative('你好世界') >= 4);
});
