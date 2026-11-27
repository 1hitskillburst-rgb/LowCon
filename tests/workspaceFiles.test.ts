import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RightSidebarPanel } from '../src/components/chat/RightSidebarPanel';
import { SettingsView } from '../src/components/views/SettingsView';
import { assembleContext, buildTurnContextBudget } from '../src/core/context';
import { InferenceController, type StreamStopReason } from '../src/core/inference';
import { DiagnosticLogger } from '../src/core/privacy';
import {
  createDefaultWorkspace,
  loadUnsealedWorkspace,
  saveUnsealedWorkspace,
  sealWorkspaceVault,
  unsealWorkspaceVault,
} from '../src/core/storage';
import {
  ALL_WORKSPACE_TOOLS,
  buildToolPolicyForTools,
  EDIT_FILE_TOOL_NAME,
  executeEditFileTool,
  executeReadAttachedChunkTool,
  executeSaveWorkspaceFileTool,
  hasExplicitWorkspaceFileSaveIntent,
  SAVE_WORKSPACE_FILE_TOOL_NAME,
  selectToolsForPromptBudget,
} from '../src/core/tier1Tools';
import type { ToolCallRecord, WorkspaceFile } from '../src/core/types';
import {
  filterAndSortWorkspaceFiles,
  formatWorkspaceFilesCatalogForPrompt,
  MAX_WORKSPACE_FILE_BYTES,
  upsertWorkspaceFile,
  workspaceFileToArtifact,
} from '../src/core/workspaceFiles';

function makeWorkspaceFile(overrides: Partial<WorkspaceFile> = {}): WorkspaceFile {
  const content = overrides.content ?? 'hello world';
  return {
    id: overrides.id ?? 'wfile_1',
    filename: overrides.filename ?? 'notes.md',
    title: overrides.title ?? 'Notes',
    language: overrides.language ?? 'markdown',
    content,
    sizeBytes: overrides.sizeBytes ?? new TextEncoder().encode(content).length,
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    updatedAt: overrides.updatedAt ?? 1_700_000_000_000,
    lockedByUser: overrides.lockedByUser ?? false,
    source: overrides.source ?? 'upload',
  };
}

test('filterAndSortWorkspaceFiles searches by name/type and sorts by type, date, name, and size', () => {
  const files: WorkspaceFile[] = [
    makeWorkspaceFile({
      id: 'f1',
      filename: 'zeta.ts',
      language: 'typescript',
      content: 'const x = 1;',
      createdAt: 100,
      updatedAt: 300,
      sizeBytes: 120,
    }),
    makeWorkspaceFile({
      id: 'f2',
      filename: 'alpha.json',
      language: 'json',
      content: '{"ok":true}',
      createdAt: 200,
      updatedAt: 100,
      sizeBytes: 40,
    }),
    makeWorkspaceFile({
      id: 'f3',
      filename: 'beta.md',
      language: 'markdown',
      content: '# README\nLonger notes here',
      createdAt: 300,
      updatedAt: 200,
      sizeBytes: 450,
    }),
  ];

  // Name search
  const searchAlpha = filterAndSortWorkspaceFiles(files, 'alph', 'name', 'asc');
  assert.deepEqual(searchAlpha.map((f) => f.filename), ['alpha.json']);

  // Sort by name asc
  assert.deepEqual(
    filterAndSortWorkspaceFiles(files, '', 'name', 'asc').map((f) => f.filename),
    ['alpha.json', 'beta.md', 'zeta.ts'],
  );

  // Sort by file type (extension badge: JSON, MD, TS)
  assert.deepEqual(
    filterAndSortWorkspaceFiles(files, '', 'type', 'asc').map((f) => f.filename),
    ['alpha.json', 'beta.md', 'zeta.ts'],
  );

  // Sort by updatedAt desc
  assert.deepEqual(
    filterAndSortWorkspaceFiles(files, '', 'updatedAt', 'desc').map((f) => f.filename),
    ['zeta.ts', 'beta.md', 'alpha.json'],
  );

  // Sort by createdAt asc
  assert.deepEqual(
    filterAndSortWorkspaceFiles(files, '', 'createdAt', 'asc').map((f) => f.filename),
    ['zeta.ts', 'alpha.json', 'beta.md'],
  );

  // Sort by size desc
  assert.deepEqual(
    filterAndSortWorkspaceFiles(files, '', 'size', 'desc').map((f) => f.filename),
    ['beta.md', 'zeta.ts', 'alpha.json'],
  );
});

test('upsertWorkspaceFile and executeSaveWorkspaceFileTool enforce per-file lock and global allowAiFileEdits toggle', () => {
  let seq = 0;
  const createId = () => `id_${++seq}`;

  // User uploads unlocked and locked files
  const r1 = upsertWorkspaceFile(
    [],
    { filename: 'config.json', content: '{"env":"prod"}', source: 'upload', lockedByUser: true },
    createId,
    { nowMs: 1000 },
  );
  assert.equal(r1.ok, true);
  if (!r1.ok) return;

  const r2 = upsertWorkspaceFile(
    r1.files,
    { filename: 'notes.md', content: '# Initial\nLine 2', source: 'upload', lockedByUser: false },
    createId,
    { nowMs: 2000 },
  );
  assert.equal(r2.ok, true);
  if (!r2.ok) return;

  // LLM cannot overwrite locked file
  const lockedAttempt = executeSaveWorkspaceFileTool(
    JSON.stringify({ filename: 'config.json', content: '{"env":"dev"}' }),
    r2.files,
    [],
    createId,
    { allowAiFileEdits: true },
  );
  assert.equal(lockedAttempt.ok, false);
  if (!lockedAttempt.ok) {
    assert.ok(lockedAttempt.error.toLowerCase().includes('locked'));
  }

  // LLM cannot overwrite unlocked file when global edits disabled
  const disabledAttempt = executeSaveWorkspaceFileTool(
    JSON.stringify({ filename: 'notes.md', content: '# Blocked' }),
    r2.files,
    [],
    createId,
    { allowAiFileEdits: false },
  );
  assert.equal(disabledAttempt.ok, false);
  if (!disabledAttempt.ok) {
    assert.ok(disabledAttempt.error.toLowerCase().includes('disabled'));
  }

  // LLM CAN remember/save a brand-new file by copying a session attachment even without retyping content
  const saveNewFromSession = executeSaveWorkspaceFileTool(
    JSON.stringify({ filename: '2048.html' }),
    r2.files,
    [{ name: '2048.html', content: '<!doctype html><html>2048</html>' }],
    createId,
    { allowAiFileEdits: false },
  );
  assert.equal(saveNewFromSession.ok, true);
  if (saveNewFromSession.ok) {
    assert.equal(saveNewFromSession.action, 'created');
    assert.equal(saveNewFromSession.file.filename, '2048.html');
    assert.ok(saveNewFromSession.file.content.includes('2048'));
  }

  // Reject oversized file
  const oversized = upsertWorkspaceFile(
    [],
    {
      filename: 'huge.txt',
      content: 'a'.repeat(MAX_WORKSPACE_FILE_BYTES + 10),
      source: 'upload',
    },
    createId,
  );
  assert.equal(oversized.ok, false);
});

test('workspace files catalog integrates cleanly with read_attached_chunk, edit_file, prompt budget, and vault persistence', async () => {
  const wf = makeWorkspaceFile({
    id: 'wf_guide',
    filename: 'style_guide.md',
    language: 'markdown',
    content: '# Style Guide\nRule 1: Keep helpers small.\nRule 2: Prefer strict types.',
    lockedByUser: false,
  });

  // 1. Prompt catalog advertises stored files compactly without dumping contents
  const catalogEnabled = formatWorkspaceFilesCatalogForPrompt([wf], true);
  assert.ok(catalogEnabled.includes('style_guide.md'));
  assert.ok(catalogEnabled.includes('editable'));
  assert.equal(catalogEnabled.includes('Rule 2: Prefer strict types.'), false);

  const catalogDisabled = formatWorkspaceFilesCatalogForPrompt([wf], false);
  assert.ok(catalogDisabled.includes('read-only/locked'));
  assert.ok(catalogDisabled.includes('AI file edits are disabled'));

  // 2. selectToolsForPromptBudget hides edit_file when allowAiFileEdits is false
  const toolsWhenDisabled = selectToolsForPromptBudget(8192, {
    hasAttachments: false,
    hasGeneratedFiles: false,
    hasWorkspaceFiles: true,
    includeWorkspaceFileTool: true,
    allowAiFileEdits: false,
  });
  assert.equal(toolsWhenDisabled.some((t) => t.function.name === EDIT_FILE_TOOL_NAME), false);
  assert.equal(
    toolsWhenDisabled.some((t) => t.function.name === SAVE_WORKSPACE_FILE_TOOL_NAME),
    true,
  );

  // 3. 4K budget fits ALL_WORKSPACE_TOOLS + workspace file catalog cleanly
  const tools4k = selectToolsForPromptBudget(4096, {
    hasAttachments: false,
    hasGeneratedFiles: false,
    hasWorkspaceFiles: true,
    includeWorkspaceFileTool: true,
    allowAiFileEdits: true,
  });
  assert.equal(tools4k.length, ALL_WORKSPACE_TOOLS.length);
  const assembled = assembleContext(
    {
      coreInstruction: `You are LowCon.\n\n${buildToolPolicyForTools(tools4k)}\n\n${catalogEnabled}`,
      currentUserMessage: 'Update style_guide.md rule 2',
      pinnedFacts: [],
      retrievedMemories: [],
      conversationTurns: [],
      summaries: [],
      tools: tools4k,
    },
    {
      modelContextLimit: 4096,
      outputReservePct: 20,
      safetyMarginPct: 5,
      templateType: 'ChatML',
    },
  );
  assert.equal(assembled.ok, true);

  // 4. Can inspect & edit workspace file via existing read_attached_chunk + edit_file tools
  const readRes = executeReadAttachedChunkTool(
    JSON.stringify({ filename: 'style_guide.md', start_line: 1, end_line: 3 }),
    [{ name: wf.filename, content: wf.content }],
  );
  assert.equal(readRes.ok, true);

  const editRes = executeEditFileTool(
    JSON.stringify({
      filename: 'style_guide.md',
      old_text: 'Rule 2: Prefer strict types.',
      new_text: 'Rule 2: Prefer strict TypeScript types.',
    }),
    [workspaceFileToArtifact(wf)],
  );
  assert.equal(editRes.ok, true);
  if (editRes.ok) {
    assert.ok(editRes.artifact.content.includes('TypeScript types'));
  }

  // 5. Mock inference triggers save_workspace_file when asked to remember a file in Files tab
  const logger = new DiagnosticLogger('disabled');
  const controller = new InferenceController(logger, () => {});
  controller.loadModel({
    id: 'mock_wf',
    name: 'Mock',
    filePath: 'in-process://mock',
    backendType: 'mock',
    architecture: 'qwen2',
    quantization: 'Deterministic',
    contextLimit: 8192,
    chatTemplate: 'ChatML',
    fileSizeBytes: 0,
  });

  const mockCall = await new Promise<{ stopReason: StreamStopReason; toolCalls?: ToolCallRecord[] }>(
    (resolve, reject) => {
      void controller.startGeneration(
        'sess_wf',
        {
          exactRenderedPrompt: '',
          structuredMessages: [
            { role: 'system', content: 'You are LowCon.' },
            { role: 'user', content: 'Remember this file in the Files tab: todo.md' },
          ],
          maxTokens: 256,
          temperature: 0.2,
          topP: 0.9,
          stopSequences: [],
          tools: ALL_WORKSPACE_TOOLS,
        },
        {
          onToken: () => {},
          onComplete: (_t, stopReason, stats) => resolve({ stopReason, toolCalls: stats?.toolCalls }),
          onCancelled: () => reject(new Error('cancelled')),
          onError: (e) => reject(new Error(e)),
        },
      );
    },
  );
  assert.equal(mockCall.stopReason, 'tool_calls');
  assert.equal(mockCall.toolCalls?.[0]?.function.name, SAVE_WORKSPACE_FILE_TOOL_NAME);

  // 6. Workspace storage & vault seal/unseal preserve workspaceFiles and allowAiFileEdits
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
  });

  const ws = createDefaultWorkspace();
  ws.workspaceFiles = [wf];
  ws.settings.allowAiFileEdits = false;
  assert.equal(saveUnsealedWorkspace(ws, logger).ok, true);
  const reloaded = loadUnsealedWorkspace(logger);
  assert.equal(reloaded.workspace.workspaceFiles.length, 1);
  assert.equal(reloaded.workspace.workspaceFiles[0].filename, 'style_guide.md');
  assert.equal(reloaded.workspace.settings.allowAiFileEdits, false);

  const sealed = await sealWorkspaceVault(reloaded.workspace, 'secret-pass', logger);
  assert.equal(sealed.ok, true);
  const unsealed = await unsealWorkspaceVault('secret-pass', logger);
  assert.equal(unsealed.ok, true);
  if (unsealed.ok) {
    assert.equal(unsealed.workspace.workspaceFiles.length, 1);
    assert.equal(unsealed.workspace.settings.allowAiFileEdits, false);
  }
});

test('RightSidebarPanel Files tab and SettingsView global edit toggle render cleanly', () => {
  const ws = createDefaultWorkspace();
  const sampleFiles: WorkspaceFile[] = [
    makeWorkspaceFile({
      id: 'wf_a',
      filename: 'architecture.md',
      language: 'markdown',
      content: '# Arch',
      lockedByUser: true,
      source: 'upload',
    }),
    makeWorkspaceFile({
      id: 'wf_b',
      filename: 'helper.ts',
      language: 'typescript',
      content: 'export const a = 1;',
      lockedByUser: false,
      source: 'ai',
    }),
  ];

  const assembled = assembleContext(
    {
      coreInstruction: 'You are LowCon.',
      currentUserMessage: '',
      pinnedFacts: [],
      retrievedMemories: [],
      conversationTurns: [],
      summaries: [],
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

  const filesHtml = renderToStaticMarkup(
    React.createElement(RightSidebarPanel, {
      activeTab: 'files',
      onSelectTab: () => {},
      budget: buildTurnContextBudget(assembled.inspection),
      memoryNotes: ws.memoryNotes,
      includedMemoryIds: [],
      memoryRetrievalEnabled: true,
      onToggleMemoryRetrieval: () => {},
      hoveredSegment: null,
      onHoverSegment: () => {},
      onOpenPromptInspector: () => {},
      workspaceFiles: sampleFiles,
      allowAiFileEdits: false,
      onUploadWorkspaceFiles: () => {},
      onToggleWorkspaceFileLock: () => {},
      onDeleteWorkspaceFile: () => {},
      onPreviewWorkspaceFile: () => {},
      onOpenFileSettings: () => {},
    }),
  );

  assert.ok(filesHtml.includes('data-testid="right-tab-context"'));
  assert.ok(filesHtml.includes('data-testid="right-tab-files"'));
  assert.ok(filesHtml.includes('data-testid="files-panel"'));
  assert.ok(filesHtml.includes('data-testid="files-upload-button"'));
  assert.ok(filesHtml.includes('data-testid="files-search-input"'));
  assert.ok(filesHtml.includes('data-testid="files-sort-select"'));
  assert.ok(filesHtml.includes('data-testid="files-global-edits-disabled-banner"'));
  assert.ok(filesHtml.includes('data-testid="file-lock-toggle-architecture.md"'));
  assert.ok(filesHtml.includes('data-testid="file-lock-toggle-helper.ts"'));
  assert.ok(filesHtml.includes('Locked'));
  assert.ok(filesHtml.includes('Editable'));

  const settingsHtml = renderToStaticMarkup(
    React.createElement(SettingsView, {
      settings: { ...ws.settings, allowAiFileEdits: false },
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

  assert.ok(settingsHtml.includes('data-testid="ai-file-edits-toggle"'));
  assert.ok(settingsHtml.includes('aria-checked="false"'));
  assert.ok(settingsHtml.includes('Allow LLM edits overall'));
});

test('hasExplicitWorkspaceFileSaveIntent only triggers when user asks to save to Files tab', () => {
  assert.equal(hasExplicitWorkspaceFileSaveIntent('make me a calculator in html'), false);
  assert.equal(hasExplicitWorkspaceFileSaveIntent('edit calculator.html to add trig functions'), false);
  assert.equal(hasExplicitWorkspaceFileSaveIntent('create and save script.py'), false);

  assert.equal(hasExplicitWorkspaceFileSaveIntent('save calculator.html to the files tab'), true);
  assert.equal(hasExplicitWorkspaceFileSaveIntent('Remember this file in the Files tab: todo.md'), true);
  assert.equal(hasExplicitWorkspaceFileSaveIntent('keep notes.md in my files across chats'), true);
  assert.equal(hasExplicitWorkspaceFileSaveIntent('remember this file'), true);
});
