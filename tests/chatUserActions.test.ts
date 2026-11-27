import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatView } from '../src/components/chat/ChatView.tsx';
import { createDefaultWorkspace } from '../src/core/storage.ts';

test('ChatView renders Copy and Retry buttons under user messages', () => {
  const ws = createDefaultWorkspace();
  const session = {
    ...ws.sessions[0],
    messages: [
      {
        id: 'u_1',
        role: 'user' as const,
        authorName: 'You',
        createdAt: Date.now() - 2000,
        content: 'Write a linked list in Rust',
        sources: [],
      },
      {
        id: 'a_1',
        role: 'assistant' as const,
        authorName: 'LowCon',
        createdAt: Date.now() - 1000,
        content: 'Here is a linked list implementation.',
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
      workerStatus: { state: 'loaded', modelId: ws.models[0].id, modelName: ws.models[0].name, backend: 'mock', contextLimit: 8192 },
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
    }),
  );

  assert.ok(html.includes('data-testid="copy-user-message-u_1"'));
  assert.ok(html.includes('data-testid="retry-user-message-u_1"'));
  assert.ok(html.includes('>Copy<'));
  assert.ok(html.includes('>Retry<'));
});

test('ChatView renders Queue button while generating and queued banner with Cancel button', () => {
  const ws = createDefaultWorkspace();
  const baseProps = {
    session: ws.sessions[0],
    models: ws.models,
    activeModelId: ws.activeModelId,
    onSelectActiveModel: () => {},
    connectedLmModels: [],
    selectedLmModel: '',
    onSelectLmModel: () => {},
    effortLevel: 'medium' as const,
    onChangeEffortLevel: () => {},
    backendLabel: 'Offline Mock',
    workerStatus: {
      state: 'generating' as const,
      modelId: ws.models[0].id,
      modelName: ws.models[0].name,
      sessionId: ws.sessions[0].id,
    },
    composerText: 'Follow up question',
    onComposerTextChange: () => {},
    attachedFile: null,
    onAttachFile: () => {},
    memoryRetrievalEnabled: true,
    onToggleMemoryRetrieval: () => {},
    isGenerating: true,
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
    onCancelQueuedRequest: () => {},
  };

  // Before queuing: Queue button is active next to Stop
  const readyToQueueHtml = renderToStaticMarkup(
    React.createElement(ChatView, {
      ...baseProps,
      queuedRequest: null,
      hasQueuedRequestAnywhere: false,
    }),
  );
  assert.ok(readyToQueueHtml.includes('data-testid="queue-message-button"'));
  assert.ok(readyToQueueHtml.includes('>Queue<'));
  assert.equal(readyToQueueHtml.includes('data-testid="queued-request-banner"'), false);

  // With 1 queued request: Banner shows queued prompt + Cancel button, and Queue button caps at 1/1
  const queuedHtml = renderToStaticMarkup(
    React.createElement(ChatView, {
      ...baseProps,
      composerText: '',
      queuedRequest: {
        rawInput: 'Follow up question',
        attachedFile: null,
      },
      hasQueuedRequestAnywhere: true,
    }),
  );
  assert.ok(queuedHtml.includes('data-testid="queued-request-banner"'));
  assert.ok(queuedHtml.includes('Queued (runs next):'));
  assert.ok(queuedHtml.includes('Follow up question'));
  assert.ok(queuedHtml.includes('data-testid="cancel-queued-request"'));
  assert.ok(queuedHtml.includes('Queued (1/1)'));
});
