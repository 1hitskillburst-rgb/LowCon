import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatView } from '../src/components/chat/ChatView.tsx';
import { SettingsView } from '../src/components/views/SettingsView.tsx';
import {
  buildContinuationInstruction,
  buildThinkingHandoffInstruction,
  computeTurnMaxTokens,
  dedupeContinuationOverlap,
  distillOlderToolTurns,
  MAX_AUTO_CONTINUATION_HOPS,
  THINKING_GUARD_RATIO,
} from '../src/core/continuation.ts';
import type { ConversationTurnCandidate } from '../src/core/context.ts';
import { createDefaultWorkspace } from '../src/core/storage.ts';

test('computeTurnMaxTokens expands to free context when enabled and respects reserve floor', () => {
  const inspection = {
    budgetPartition: {
      totalLimit: 8192,
      safetyMargin: 410,
      outputReserve: 1200,
      promptBudget: 6582,
    },
    remainingCapacity: 4000,
  };

  assert.equal(computeTurnMaxTokens(inspection, true), 5200);
  assert.equal(computeTurnMaxTokens(inspection, false), 1200);
  assert.equal(
    computeTurnMaxTokens({
      budgetPartition: {
        totalLimit: 2048,
        safetyMargin: 100,
        outputReserve: 300,
        promptBudget: 1648,
      },
      remainingCapacity: -50,
    }),
    300,
  );
  assert.ok(MAX_AUTO_CONTINUATION_HOPS >= 2);
  assert.ok(THINKING_GUARD_RATIO > 0.5 && THINKING_GUARD_RATIO < 1);
});

test('dedupeContinuationOverlap removes echoed trailing suffix without dropping fresh text', () => {
  const existing = 'Here is the implementation:\n```ts\nfunction add(a: number, b: number) {\n  return a + b;';
  const nextChunk = 'return a + b;\n}\n```';
  assert.equal(dedupeContinuationOverlap(existing, nextChunk), '\n}\n```');

  const disjointChunk = '\nconsole.log(add(2, 3));';
  assert.equal(dedupeContinuationOverlap(existing, disjointChunk), disjointChunk);
});

test('buildThinkingHandoffInstruction and buildContinuationInstruction preserve anchors cleanly', () => {
  const handoff = buildThinkingHandoffInstruction(
    'First let us analyze the AST traversal. '.repeat(20) + 'Final plan: emit clean TypeScript.',
  );
  assert.match(handoff, /thinkingNotes|Reasoning/i);
  assert.match(handoff, /Final plan: emit clean TypeScript/);

  const cont = buildContinuationInstruction('Step 1 done. Step 2 starts here: process each item');
  assert.match(cont, /Continue seamlessly/i);
  assert.match(cont, /Step 2 starts here: process each item/);
});

test('distillOlderToolTurns compacts older tool groups while keeping the latest tool group intact', () => {
  const turns: ConversationTurnCandidate[] = [
    { id: 'u1', role: 'user', content: 'Analyze files' },
    {
      id: 'a1',
      role: 'assistant',
      content: 'Reading file A...',
      toolCalls: [
        {
          id: 'c1',
          type: 'function',
          function: {
            name: 'read_attached_chunk',
            arguments: JSON.stringify({ filename: 'a.txt', longArg: 'x'.repeat(300) }),
          },
        },
      ],
    },
    {
      id: 't1',
      role: 'tool',
      toolCallId: 'c1',
      name: 'read_attached_chunk',
      content: 'Very long file content '.repeat(40),
    },
    {
      id: 'a2',
      role: 'assistant',
      content: 'Editing file B...',
      toolCalls: [
        {
          id: 'c2',
          type: 'function',
          function: {
            name: 'edit_file',
            arguments: JSON.stringify({ filename: 'b.txt', start_line: 1, replacement: 'new' }),
          },
        },
      ],
    },
    {
      id: 't2',
      role: 'tool',
      toolCallId: 'c2',
      name: 'edit_file',
      content: '{"status":"ok","filename":"b.txt"}',
    },
  ];

  const distilled = distillOlderToolTurns(turns, 1);
  assert.equal(distilled.length, 4);
  assert.equal(distilled[0].content, 'Analyze files');
  assert.match(distilled[1].content, /Completed earlier tool steps/);
  assert.equal(distilled[3].content, '{"status":"ok","filename":"b.txt"}');
});

test('ChatView shows Continue button on max_tokens replies (partial and thinking-only)', () => {
  const ws = createDefaultWorkspace();
  const session = {
    ...ws.sessions[0],
    messages: [
      {
        id: 'u_1',
        role: 'user' as const,
        authorName: 'You',
        createdAt: 1000,
        content: 'Write a detailed architecture guide',
        sources: [],
      },
      {
        id: 'a_partial',
        role: 'assistant' as const,
        authorName: 'LowCon',
        createdAt: 2000,
        content: 'Section 1: Overview...',
        stopReason: 'max_tokens' as const,
        sources: [],
      },
      {
        id: 'a_think_only',
        role: 'assistant' as const,
        authorName: 'LowCon',
        createdAt: 3000,
        content: '',
        thinkingContent: 'Considering edge cases...',
        stopReason: 'max_tokens' as const,
        sources: [],
      },
    ],
  };

  const html = renderToStaticMarkup(
    React.createElement(ChatView, {
      session,
      models: ws.models,
      activeModelId: ws.activeModelId,
      onSelectActiveModel: () => {},
      connectedLmModels: [],
      selectedLmModel: '',
      onSelectLmModel: () => {},
      effortLevel: 'medium',
      onChangeEffortLevel: () => {},
      backendLabel: 'Offline Mock',
      workerStatus: {
        state: 'loaded',
        modelId: ws.models[0].id,
        modelName: ws.models[0].name,
        backend: 'mock',
        contextLimit: 8192,
      },
      composerText: '',
      onComposerTextChange: () => {},
      attachedFile: null,
      onAttachFile: () => {},
      memoryRetrievalEnabled: true,
      onToggleMemoryRetrieval: () => {},
      isGenerating: false,
      hoveredSegment: null,
      onHoverSegment: () => {},
      onSendMessage: () => {},
      onStopGeneration: () => {},
      onNewSession: () => {},
      onSummarizeSession: () => true,
      onReviewSummaries: () => {},
      onOpenSources: () => {},
      onSaveAsNote: () => {},
      onOpenFilePreview: () => {},
      onRetryUserMessage: () => {},
      onContinueMessage: () => {},
    }),
  );

  assert.match(html, /data-testid="continue-message-a_partial"/);
  assert.match(html, /data-testid="continue-message-a_think_only"/);
});

test('SettingsView renders anti-stopping budget toggles with expected defaults', () => {
  const ws = createDefaultWorkspace();
  const html = renderToStaticMarkup(
    React.createElement(SettingsView, {
      settings: ws.settings,
      activeModel: ws.models[0],
      diagnosticEntries: [],
      isTestingConnection: false,
      onUpdateSettings: () => {},
      onSwitchBackend: () => {},
      onTestLmStudioConnection: async () => {},
      onSelectLmModel: () => {},
      onLockVault: async () => ({ ok: true }),
      onClearDiagnostics: () => {},
    }),
  );

  assert.match(html, /aria-checked="true"[^>]*data-testid="toggle-expand-reply-budget"/);
  assert.match(html, /aria-checked="true"[^>]*data-testid="toggle-auto-continue"/);
  assert.match(html, /aria-checked="false"[^>]*data-testid="toggle-thinking-guard"/);
});
