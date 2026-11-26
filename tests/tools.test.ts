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
import { createDefaultModels } from '../src/core/storage';
import {
  CREATE_FILE_TOOL_DEFINITION,
  CREATE_FILE_TOOL_NAME,
  executeCreateFileTool,
  sanitizeGeneratedFilename,
} from '../src/core/tools';
import type { ToolCallRecord } from '../src/core/types';

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
