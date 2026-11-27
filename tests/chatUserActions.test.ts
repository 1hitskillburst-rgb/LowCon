import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatView } from '../src/components/chat/ChatView.tsx';
import { RightSidebarPanel } from '../src/components/chat/RightSidebarPanel.tsx';
import { SidebarNav } from '../src/components/layout/SidebarNav.tsx';
import { assembleContext, buildTurnContextBudget } from '../src/core/context.ts';
import {
  clampLeftSidebarWidth,
  clampRightSidebarWidth,
  LEFT_SIDEBAR_DEFAULT,
  LEFT_SIDEBAR_MAX,
  LEFT_SIDEBAR_MIN,
  RIGHT_SIDEBAR_DEFAULT,
  RIGHT_SIDEBAR_MAX,
  RIGHT_SIDEBAR_MIN,
} from '../src/core/sidebarLayout.ts';
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

test('ChatView header renders sidebar toggle icons and omits legacy Worker/LM/Model dropdown', () => {
  const ws = createDefaultWorkspace();
  const html = renderToStaticMarkup(
    React.createElement(ChatView, {
      session: ws.sessions[0],
      models: ws.models,
      activeModelId: ws.activeModelId,
      onSelectActiveModel: () => {},
      connectedLmModels: ['qwen3-8b'],
      selectedLmModel: 'qwen3-8b',
      onSelectLmModel: () => {},
      effortLevel: 'medium',
      onChangeEffortLevel: () => {},
      backendLabel: 'LM Studio (Loopback)',
      workerStatus: {
        state: 'loaded',
        modelId: ws.models[0].id,
        modelName: ws.models[0].name,
        backend: 'lm_studio',
        contextLimit: 8192,
      },
      leftSidebarOpen: true,
      onToggleLeftSidebar: () => {},
      rightSidebarOpen: false,
      onToggleRightSidebar: () => {},
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
    }),
  );

  assert.ok(html.includes('data-testid="toggle-left-sidebar"'));
  assert.ok(html.includes('data-testid="toggle-right-sidebar"'));
  assert.equal(html.includes('Worker ready'), false);
  assert.equal(html.includes('LM Studio (Loopback)'), false);
  assert.equal(html.includes('chat-active-model-select'), false);
});

test('Sidebar resize clamping and resizer handles behave accurately on left and right sidebars', () => {
  assert.equal(clampLeftSidebarWidth(50), LEFT_SIDEBAR_MIN);
  assert.equal(clampLeftSidebarWidth(900), LEFT_SIDEBAR_MAX);
  assert.equal(clampLeftSidebarWidth(Number.NaN), LEFT_SIDEBAR_DEFAULT);

  assert.equal(clampRightSidebarWidth(100), RIGHT_SIDEBAR_MIN);
  assert.equal(clampRightSidebarWidth(999), RIGHT_SIDEBAR_MAX);
  assert.equal(clampRightSidebarWidth(Number.POSITIVE_INFINITY), RIGHT_SIDEBAR_DEFAULT);

  const ws = createDefaultWorkspace();
  const leftHtml = renderToStaticMarkup(
    React.createElement(SidebarNav, {
      currentTab: 'chat',
      onSelectTab: () => {},
      sessions: ws.sessions,
      activeSessionId: ws.activeSessionId,
      generatingSessionId: null,
      onSelectSession: () => {},
      onNewSession: () => {},
      onDeleteSession: () => {},
      width: 260,
      onResizeWidth: () => {},
    }),
  );
  assert.ok(leftHtml.includes('data-testid="left-sidebar-resizer"'));
  assert.ok(leftHtml.includes('width:260px'));

  const assembled = assembleContext(
    {
      coreInstruction: 'Helpful assistant.',
      pinnedFacts: [],
      retrievedMemories: [],
      summaries: [],
      conversationTurns: [],
      currentUserMessage: '',
    },
    {
      modelContextLimit: 8192,
      outputReservePct: 20,
      safetyMarginPct: 5,
      templateType: 'ChatML',
      allowEmptyUserMessage: true,
    },
  );
  assert.equal(assembled.ok, true);
  if (!assembled.ok) return;

  const rightHtml = renderToStaticMarkup(
    React.createElement(RightSidebarPanel, {
      activeTab: 'context',
      onSelectTab: () => {},
      budget: buildTurnContextBudget(assembled.inspection),
      onUpdateTaskGoal: () => {},
      memoryNotes: [],
      includedMemoryIds: [],
      memoryRetrievalEnabled: true,
      onToggleMemoryRetrieval: () => {},
      hoveredSegment: null,
      onHoverSegment: () => {},
      onOpenPromptInspector: () => {},
      workspaceFiles: [],
      allowAiFileEdits: true,
      onUploadWorkspaceFiles: () => {},
      onToggleWorkspaceFileLock: () => {},
      onDeleteWorkspaceFile: () => {},
      onPreviewWorkspaceFile: () => {},
      width: 390,
      onResizeWidth: () => {},
    }),
  );
  assert.ok(rightHtml.includes('data-testid="right-sidebar-resizer"'));
  assert.ok(rightHtml.includes('width:390px'));
});
