import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleContext,
  buildTurnContextBudget,
  getFreeTokens,
  getPackedTokens,
} from '../src/core/context';
import {
  consumeSseStream,
  InferenceController,
  type StreamStopReason,
} from '../src/core/inference';
import { DiagnosticLogger } from '../src/core/privacy';
import { createDefaultMemoryNotes, createDefaultModels } from '../src/core/storage';
import {
  ALL_FILE_AND_TIER1_TOOLS,
  buildToolPolicyForTools,
  CALCULATE_TOOL_NAME,
  EDIT_FILE_TOOL_DEFINITION,
  EDIT_FILE_TOOL_NAME,
  executeCalculateTool,
  executeEditFileTool,
  executeReadAttachedChunkTool,
  executeSaveMemoryNoteTool,
  executeSearchMemoryTool,
  formatAttachedFileForPrompt,
  FULL_TOOL_CALL_POLICY_INSTRUCTION,
  READ_ATTACHED_CHUNK_TOOL_NAME,
  SAVE_MEMORY_TOOL_NAME,
  SEARCH_MEMORY_TOOL_NAME,
  selectToolsForPromptBudget,
  shouldIndexAttachedFile,
} from '../src/core/tier1Tools';
import {
  CREATE_FILE_TOOL_DEFINITION,
  CREATE_FILE_TOOL_NAME,
  DuplicateFileCodeFilter,
  executeCreateFileTool,
  isDuplicateGeneratedFileBlock,
  sanitizeGeneratedFilename,
} from '../src/core/tools';
import type { GeneratedFileArtifact, MemoryNote, ToolCallRecord } from '../src/core/types';

function makeSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

test('executeCreateFileTool sanitizes filenames, infers language/title, and rejects invalid inputs', () => {
  assert.equal(sanitizeGeneratedFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeGeneratedFilename('', 'rust'), 'generated_file.rs');

  let seq = 0;
  const okRes = executeCreateFileTool(
    JSON.stringify({
      filename: 'src/recursive_linked_list.rs',
      content: 'fn main() {}\n',
    }),
    () => `0000000${++seq}`,
  );
  assert.equal(okRes.ok, true);
  if (okRes.ok) {
    assert.equal(okRes.artifact.filename, 'recursive_linked_list.rs');
    assert.equal(okRes.artifact.language, 'rust');
    assert.equal(okRes.artifact.title, 'Recursive linked list');
  }

  const badJson = executeCreateFileTool('{bad', () => '1');
  assert.equal(badJson.ok, false);

  const emptyContent = executeCreateFileTool(
    JSON.stringify({ filename: 'empty.ts', content: '   ' }),
    () => '2',
  );
  assert.equal(emptyContent.ok, false);
});

test('consumeSseStream accumulates split native delta.tool_calls chunks and emits tool_calls stopReason', async () => {
  const stream = makeSseStream([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"create_file","arguments":"{\\"filename\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"demo.rs\\",\\"content\\":\\"fn main() {}\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  let detectedName = '';
  let finalReason: StreamStopReason | null = null;
  let finalCalls: ToolCallRecord[] | undefined;

  await consumeSseStream(stream, new AbortController().signal, {
    onToken: () => {},
    onToolCallDetected: (name) => {
      detectedName = name;
    },
    onComplete: (_tokens, stopReason, stats) => {
      finalReason = stopReason;
      finalCalls = stats?.toolCalls;
    },
    onCancelled: () => assert.fail('unexpected cancel'),
    onError: (msg) => assert.fail(`unexpected error: ${msg}`),
  });

  assert.equal(detectedName, 'create_file');
  assert.equal(finalReason, 'tool_calls');
  assert.equal(finalCalls?.length, 1);
  assert.equal(finalCalls?.[0]?.id, 'call_1');
  assert.deepEqual(JSON.parse(finalCalls?.[0]?.function.arguments ?? '{}'), {
    filename: 'demo.rs',
    content: 'fn main() {}',
  });
});

test('consumeSseStream extracts prompt-based <tool_call> tags without leaking raw JSON to visible text', async () => {
  const stream = makeSseStream([
    'data: {"choices":[{"delta":{"content":"Creating it now.<tool_"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"call>{\\"name\\":\\"create_file\\",\\"arguments\\":{\\"filename\\":\\"a.py\\",\\"content\\":\\"print(1)\\"}}</tool_ca"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"ll>"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  ]);

  let visible = '';
  let finalReason: StreamStopReason | null = null;
  let finalCalls: ToolCallRecord[] | undefined;

  await consumeSseStream(stream, new AbortController().signal, {
    onToken: (tok) => {
      visible += tok;
    },
    onComplete: (_tokens, stopReason, stats) => {
      finalReason = stopReason;
      finalCalls = stats?.toolCalls;
    },
    onCancelled: () => assert.fail('unexpected cancel'),
    onError: (msg) => assert.fail(`unexpected error: ${msg}`),
  });

  assert.equal(visible.trim(), 'Creating it now.');
  assert.equal(finalReason, 'tool_calls');
  assert.equal(finalCalls?.length, 1);
  assert.equal(finalCalls?.[0]?.function.name, 'create_file');
});

test('assembleContext accounts for tool schemas and tool message turns within budget invariants', () => {
  const res = assembleContext(
    {
      coreInstruction: 'You are LowCon.',
      currentUserMessage: '',
      pinnedFacts: [],
      retrievedMemories: [],
      conversationTurns: [
        { id: 'u1', role: 'user', content: 'Create hello.rs' },
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'create_file',
                arguments: '{"filename":"hello.rs","content":"fn main() {}"}',
              },
            },
          ],
        },
        {
          id: 't1',
          role: 'tool',
          toolCallId: 'call_1',
          name: 'create_file',
          content: '{"status":"ok","filename":"hello.rs"}',
        },
      ],
      summaries: [],
      tools: [CREATE_FILE_TOOL_DEFINITION],
    },
    {
      modelContextLimit: 8192,
      outputReservePct: 20,
      safetyMarginPct: 5,
      templateType: 'ChatML',
      allowEmptyUserMessage: true,
    },
  );

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.inspection.tools?.length, 1);
    assert.equal(res.inspection.structuredMessages.some((m) => m.role === 'tool'), true);
    assert.equal(
      res.inspection.structuredMessages[res.inspection.structuredMessages.length - 1]?.role,
      'tool',
    );
    const budget = buildTurnContextBudget(res.inspection);
    const packed = getPackedTokens(budget);
    const free = getFreeTokens(budget);
    const held = budget.segments.filter((s) => s.isHeld).reduce((sum, s) => sum + s.tokens, 0);
    assert.equal(packed, res.inspection.totalTokens);
    assert.equal(packed + free + held, budget.totalLimit);
  }
});

test('mock harness calls create_file for file requests and uses inline code blocks for snippet examples', async () => {
  const logger = new DiagnosticLogger('disabled');
  const controller = new InferenceController(logger, () => {});
  const mockModel = createDefaultModels()[0];
  assert.equal(controller.loadModel(mockModel).ok, true);

  // 1. Full file request -> tool call
  let fileStop: StreamStopReason | null = null;
  let fileCalls: ToolCallRecord[] | undefined;
  await controller.startGeneration(
    's1',
    {
      exactRenderedPrompt: 'generate a rust file for a recursive linked list',
      structuredMessages: [
        { role: 'user', content: 'can you generate a rust file that is a recursive linked list' },
      ],
      maxTokens: 1024,
      temperature: 0.7,
      topP: 0.9,
      stopSequences: [],
      tools: [CREATE_FILE_TOOL_DEFINITION],
    },
    {
      onToken: () => {},
      onComplete: (_tokens, stopReason, stats) => {
        fileStop = stopReason;
        fileCalls = stats?.toolCalls;
      },
      onCancelled: () => assert.fail('unexpected cancel'),
      onError: (err) => assert.fail(err),
    },
  );
  assert.equal(fileStop, 'tool_calls');
  assert.equal(fileCalls?.[0]?.function.name, CREATE_FILE_TOOL_NAME);

  // 2. Snippet / example request -> inline code block, no tool call
  let snippetText = '';
  let snippetStop: StreamStopReason | null = null;
  let snippetCalls: ToolCallRecord[] | undefined;
  await controller.startGeneration(
    's2',
    {
      exactRenderedPrompt: 'show me a quick rust match example',
      structuredMessages: [{ role: 'user', content: 'show me a quick rust match example' }],
      maxTokens: 1024,
      temperature: 0.7,
      topP: 0.9,
      stopSequences: [],
      tools: [CREATE_FILE_TOOL_DEFINITION],
    },
    {
      onToken: (tok) => {
        snippetText += tok;
      },
      onComplete: (_tokens, stopReason, stats) => {
        snippetStop = stopReason;
        snippetCalls = stats?.toolCalls;
      },
      onCancelled: () => assert.fail('unexpected cancel'),
      onError: (err) => assert.fail(err),
    },
  );
  assert.equal(snippetStop, 'done');
  assert.equal(snippetCalls, undefined);
  assert.ok(snippetText.includes('```rust'));
});

test('DuplicateFileCodeFilter strips redundant code blocks matching created files while keeping CLI examples', () => {
  const fileContent = [
    'use std::fmt;',
    'struct Node<T> {',
    '    value: T,',
    '    next: Option<Box<Node<T>>>,',
    '}',
    'impl<T> Node<T> {',
    '    fn new(value: T) -> Self {',
    '        Node { value, next: None }',
    '    }',
    '    fn len(&self) -> usize {',
    '        1 + self.next.as_ref().map_or(0, |n| n.len())',
    '    }',
    '}',
  ].join('\n');

  const files: GeneratedFileArtifact[] = [
    {
      id: 'f1',
      filename: 'list.rs',
      title: 'List',
      language: 'rust',
      content: fileContent,
      createdAt: Date.now(),
    },
  ];

  assert.equal(isDuplicateGeneratedFileBlock('rust', fileContent, files), true);
  assert.equal(isDuplicateGeneratedFileBlock('bash', 'rustc list.rs\n./list', files), false);

  let emitted = '';
  const filter = new DuplicateFileCodeFilter(
    () => files,
    (chunk) => {
      emitted += chunk;
    },
  );

  const responseText = [
    'I created `list.rs` with recursive node traversal.\n\n',
    '```rust\n',
    fileContent,
    '\n```\n\n',
    'Run it with:\n\n',
    '```bash\nrustc list.rs && ./list\n```\n',
  ].join('');

  for (let i = 0; i < responseText.length; i += 7) {
    filter.push(responseText.slice(i, i + 7));
  }
  filter.flush();

  assert.equal(emitted.includes('struct Node<T>'), false);
  assert.equal(emitted.includes('I created `list.rs`'), true);
  assert.equal(emitted.includes('rustc list.rs && ./list'), true);
});

async function runMockStep(
  controller: InferenceController,
  sessionId: string,
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ToolCallRecord[];
    tool_call_id?: string;
    name?: string;
  }>,
  tools = ALL_FILE_AND_TIER1_TOOLS,
): Promise<{ text: string; stopReason: StreamStopReason | null; toolCalls?: ToolCallRecord[] }> {
  let text = '';
  let stopReason: StreamStopReason | null = null;
  let toolCalls: ToolCallRecord[] | undefined;

  await controller.startGeneration(
    sessionId,
    {
      exactRenderedPrompt: messages.map((m) => m.content ?? '').join('\n'),
      structuredMessages: messages,
      maxTokens: 1024,
      temperature: 0.7,
      topP: 0.9,
      stopSequences: [],
      tools,
    },
    {
      onToken: (tok) => {
        text += tok;
      },
      onComplete: (_tokens, reason, stats) => {
        stopReason = reason;
        toolCalls = stats?.toolCalls;
      },
      onCancelled: () => assert.fail('unexpected cancel'),
      onError: (err) => assert.fail(err),
    },
  );

  return { text, stopReason, toolCalls };
}

test('mock harness and Tier 1 runtime execute calculate, edit_file, read_attached_chunk, search_memory, and save_memory_note end-to-end', async () => {
  const logger = new DiagnosticLogger('disabled');
  const controller = new InferenceController(logger, () => {});
  const mockModel = createDefaultModels()[0];
  assert.equal(controller.loadModel(mockModel).ok, true);

  // 1. calculate
  const calcStep1 = await runMockStep(controller, 't1', [
    { role: 'user', content: 'calculate round(sqrt(144) * pi, 2)' },
  ]);
  assert.equal(calcStep1.stopReason, 'tool_calls');
  assert.equal(calcStep1.toolCalls?.[0]?.function.name, CALCULATE_TOOL_NAME);
  const calcExec = executeCalculateTool(calcStep1.toolCalls![0].function.arguments);
  assert.equal(calcExec.ok, true);
  if (calcExec.ok) {
    assert.equal(calcExec.formatted, '37.7');
  }
  const calcStep2 = await runMockStep(controller, 't1', [
    { role: 'user', content: 'calculate round(sqrt(144) * pi, 2)' },
    { role: 'assistant', content: null, tool_calls: calcStep1.toolCalls },
    {
      role: 'tool',
      tool_call_id: calcStep1.toolCalls![0].id,
      name: CALCULATE_TOOL_NAME,
      content: calcExec.toolResultJson,
    },
  ]);
  assert.equal(calcStep2.stopReason, 'done');
  assert.ok(calcStep2.text.includes('37.7'));

  // 2. edit_file across session history
  const existingArtifact: GeneratedFileArtifact = {
    id: 'file_demo',
    filename: 'example.ts',
    title: 'Example',
    language: 'typescript',
    content: "export function greet() {\n  return 'LowCon';\n}\n",
    createdAt: Date.now(),
  };
  const editStep1 = await runMockStep(controller, 't2', [
    {
      role: 'assistant',
      content: 'Created file.\n\n[Attached generated files: example.ts (typescript, 3 lines)]',
    },
    { role: 'user', content: "Update example.ts to replace 'LowCon' with 'Local Workbench'" },
  ]);
  assert.equal(editStep1.stopReason, 'tool_calls');
  assert.equal(editStep1.toolCalls?.[0]?.function.name, EDIT_FILE_TOOL_NAME);
  const editExec = executeEditFileTool(editStep1.toolCalls![0].function.arguments, [existingArtifact]);
  assert.equal(editExec.ok, true);
  if (editExec.ok) {
    assert.ok(editExec.artifact.content.includes("'Local Workbench'"));
    assert.equal(editExec.linesChanged, 1);
  }
  const editStep2 = await runMockStep(controller, 't2', [
    { role: 'user', content: "Update example.ts to replace 'LowCon' with 'Local Workbench'" },
    { role: 'assistant', content: null, tool_calls: editStep1.toolCalls },
    {
      role: 'tool',
      tool_call_id: editStep1.toolCalls![0].id,
      name: EDIT_FILE_TOOL_NAME,
      content: editExec.toolResultJson,
    },
  ]);
  assert.equal(editStep2.stopReason, 'done');
  assert.ok(editStep2.text.includes('example.ts'));

  // 3. read_attached_chunk with compact indexing on >80 lines
  const largeLines = Array.from({ length: 120 }, (_, i) => `export const item${i + 1} = ${i + 1};`);
  const largeAttachment = { name: 'big_module.ts', content: largeLines.join('\n') };
  assert.equal(shouldIndexAttachedFile(largeAttachment.content), true);
  const formattedLarge = formatAttachedFileForPrompt(largeAttachment);
  assert.equal(formattedLarge.isIndexed, true);
  assert.ok(formattedLarge.promptBlock.length < largeAttachment.content.length / 2);

  const readStep1 = await runMockStep(controller, 't3', [
    { role: 'user', content: `Inspect lines 10-25\n\n${formattedLarge.promptBlock}` },
  ]);
  assert.equal(readStep1.stopReason, 'tool_calls');
  assert.equal(readStep1.toolCalls?.[0]?.function.name, READ_ATTACHED_CHUNK_TOOL_NAME);
  const readExec = executeReadAttachedChunkTool(readStep1.toolCalls![0].function.arguments, [
    largeAttachment,
  ]);
  assert.equal(readExec.ok, true);
  if (readExec.ok) {
    assert.equal(readExec.startLine, 10);
    assert.equal(readExec.endLine, 25);
    assert.ok(readExec.content.includes('10: export const item10 = 10;'));
  }

  // 4. search_memory
  const notes: MemoryNote[] = createDefaultMemoryNotes('t4');
  const searchStep1 = await runMockStep(controller, 't4', [
    { role: 'user', content: 'Search memory for deterministic prompt packing' },
  ]);
  assert.equal(searchStep1.stopReason, 'tool_calls');
  assert.equal(searchStep1.toolCalls?.[0]?.function.name, SEARCH_MEMORY_TOOL_NAME);
  const searchExec = executeSearchMemoryTool(
    searchStep1.toolCalls![0].function.arguments,
    notes,
    't4',
  );
  assert.equal(searchExec.ok, true);
  if (searchExec.ok) {
    assert.ok(searchExec.count >= 1);
  }

  // 5. save_memory_note
  const saveStep1 = await runMockStep(controller, 't5', [
    { role: 'user', content: 'Remember that we always run tsx tests before committing' },
  ]);
  assert.equal(saveStep1.stopReason, 'tool_calls');
  assert.equal(saveStep1.toolCalls?.[0]?.function.name, SAVE_MEMORY_TOOL_NAME);
  const saveExec = executeSaveMemoryNoteTool(
    saveStep1.toolCalls![0].function.arguments,
    () => 'tier1test1',
    'Integration Test Session',
    't5',
  );
  assert.equal(saveExec.ok, true);
  if (saveExec.ok) {
    assert.ok(saveExec.note.content.includes('tsx tests'));
  }
});

test('assembleContext packs ALL_FILE_AND_TIER1_TOOLS and indexed large attachment within 4K budget invariants', () => {
  const smallAttachment = { name: 'tiny.txt', content: 'short line 1\nshort line 2' };
  assert.equal(shouldIndexAttachedFile(smallAttachment.content), false);
  const smallPrompt = formatAttachedFileForPrompt(smallAttachment);
  assert.equal(smallPrompt.isIndexed, false);
  assert.ok(smallPrompt.promptBlock.includes('short line 1'));

  const hugeContent = Array.from({ length: 240 }, (_, i) => `const row_${i} = "payload_${i}";`).join(
    '\n',
  );
  const indexed = formatAttachedFileForPrompt({ name: 'huge.ts', content: hugeContent });
  assert.equal(indexed.isIndexed, true);

  const res = assembleContext(
    {
      coreInstruction: `You are LowCon.\n\n${FULL_TOOL_CALL_POLICY_INSTRUCTION}`,
      currentUserMessage: `Summarize huge.ts\n\n${indexed.promptBlock}`,
      pinnedFacts: [],
      retrievedMemories: [],
      conversationTurns: [],
      summaries: [],
      tools: ALL_FILE_AND_TIER1_TOOLS,
    },
    {
      modelContextLimit: 4096,
      outputReservePct: 20,
      safetyMarginPct: 5,
      templateType: 'ChatML',
    },
  );

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.inspection.tools?.length, 6);
    const budget = buildTurnContextBudget(res.inspection);
    const packed = getPackedTokens(budget);
    const free = getFreeTokens(budget);
    const held = budget.segments.filter((s) => s.isHeld).reduce((sum, s) => sum + s.tokens, 0);
    assert.equal(packed, res.inspection.totalTokens);
    assert.equal(packed + free + held, 4096);
  }

  // Verify EDIT_FILE_TOOL_DEFINITION declares top-level edit fields matching executeEditFileTool
  const editProps = (
    EDIT_FILE_TOOL_DEFINITION.function.parameters as { properties?: Record<string, unknown> }
  ).properties;
  for (const key of ['filename', 'edits', 'start_line', 'end_line', 'replacement', 'old_text', 'new_text', 'replace_all']) {
    assert.ok(editProps && key in editProps, `Expected '${key}' in edit_file schema properties`);
  }

  // Verify 2K (2048) budget fits default pinned rule + indexed 120-line attachment + scoped Tier 1 tools
  const indexed120 = formatAttachedFileForPrompt({
    name: 'module_120.ts',
    content: Array.from({ length: 120 }, (_, i) => `export function fn${i}() { return ${i}; }`).join('\n'),
  });
  const defaultPinned = createDefaultMemoryNotes('s_2k').filter((n) => n.isPinned);
  for (const scenario of [
    { hasAttachments: true, hasGeneratedFiles: false },
    { hasAttachments: true, hasGeneratedFiles: true },
    { hasAttachments: false, hasGeneratedFiles: true },
    { hasAttachments: false, hasGeneratedFiles: false },
  ]) {
    const tools2k = selectToolsForPromptBudget(2048, scenario);
    const policy2k = buildToolPolicyForTools(tools2k);
    const res2k = assembleContext(
      {
        coreInstruction: `You are LowCon.\n\n${policy2k}`,
        currentUserMessage: scenario.hasAttachments
          ? `Inspect lines 1-20\n\n${indexed120.promptBlock}`
          : 'Hello',
        pinnedFacts: defaultPinned.map((n) => ({
          id: n.id,
          title: n.title,
          content: n.content,
          sourceReference: n.sourceReference,
        })),
        retrievedMemories: [],
        conversationTurns: [],
        summaries: [],
        tools: tools2k,
      },
      {
        modelContextLimit: 2048,
        outputReservePct: 20,
        safetyMarginPct: 5,
        templateType: 'ChatML',
      },
    );
    assert.equal(
      res2k.ok,
      true,
      `Expected 2K budget to fit for scenario ${JSON.stringify(scenario)}: ${res2k.ok ? '' : res2k.message}`,
    );
  }
});

