import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DiagnosticLogger,
  isLocalEndpoint,
  normalizeApiEndpoint,
  safeTruncateChars,
  sanitizeDiagnosticMessage,
} from '../src/core/privacy';
import { decryptVaultString, encryptVaultString, VaultError } from '../src/core/vault';
import { createMockGgufBytes, parseGgufHeader } from '../src/core/gguf';
import {
  consumeSseStream,
  parseSseLine,
  type GenerationProgress,
} from '../src/core/inference';

test('loopback privacy boundary allows local addresses and blocks remote hosts', () => {
  assert.equal(isLocalEndpoint('http://127.0.0.1:1234/v1'), true);
  assert.equal(isLocalEndpoint('http://localhost:11434/v1'), true);
  assert.equal(isLocalEndpoint('http://[::1]:8080/v1'), true);
  assert.equal(isLocalEndpoint('127.0.0.1:1234'), true);

  assert.equal(isLocalEndpoint('https://api.openai.com/v1'), false);
  assert.equal(isLocalEndpoint('http://192.168.1.50:1234/v1'), false);
  assert.equal(isLocalEndpoint('https://cloud-llm.example.com/v1'), false);

  assert.equal(normalizeApiEndpoint('127.0.0.1:1234'), 'http://127.0.0.1:1234/v1');
  assert.equal(normalizeApiEndpoint('http://localhost:11434/'), 'http://localhost:11434/v1');
});

test('AES-256-GCM vault roundtrip succeeds and rejects wrong passphrase or tampering', async () => {
  const payload = JSON.stringify({ secret: 'Private local conversation' });
  const sealed = await encryptVaultString('StrongPass#2026', payload);
  assert.notEqual(sealed, payload);

  const decrypted = await decryptVaultString('StrongPass#2026', sealed);
  assert.equal(decrypted, payload);

  await assert.rejects(
    () => decryptVaultString('WrongPass', sealed),
    (err: unknown) => err instanceof VaultError && err.code === 'DECRYPTION_FAILED',
  );

  // Tamper final byte
  const tampered = sealed.slice(0, -2) + (sealed.endsWith('AA') ? 'BB' : 'AA');
  await assert.rejects(() => decryptVaultString('StrongPass#2026', tampered));
});

test('diagnostic logger redacts credentials and handles multi-byte Unicode safely', () => {
  const sanitized = sanitizeDiagnosticMessage(
    'İstanbul prompt: Secret user message 🚀\nAuth token=ghp_abc123456 password=MyPassword123',
  );
  assert.equal(sanitized.includes('Secret user message'), false);
  assert.equal(sanitized.includes('ghp_abc123456'), false);
  assert.equal(sanitized.includes('MyPassword123'), false);
  assert.ok(sanitized.includes('[REDACTED]'));

  const logger = new DiagnosticLogger('disabled');
  logger.info('core', 'should not log');
  assert.equal(logger.getEntries().length, 0);

  logger.setLevel('minimal_redacted');
  logger.error('storage', 'Failed with passphrase=topsecret');
  assert.equal(logger.getEntries().length, 1);
  assert.equal(logger.getEntries()[0].message.includes('topsecret'), false);

  // Safe char truncation never splits multi-byte emoji
  const trunc = safeTruncateChars('Hello 🚀🔥✨ world with unicode — emdash', 12);
  assert.equal(Array.from(trunc).length, 12);
});

test('GGUF binary header parser extracts metadata and rejects invalid/truncated headers', () => {
  const valid = createMockGgufBytes('llama', 'Llama-3-8B-Instruct', 8192, 15, '<|start_header_id|>');
  const meta = parseGgufHeader(valid, 4_200_000_000, 'llama3.gguf');
  assert.equal(meta.name, 'Llama-3-8B-Instruct');
  assert.equal(meta.architecture, 'llama');
  assert.equal(meta.contextLength, 8192);
  assert.equal(meta.quantization, 'Q4_K_M');
  assert.equal(meta.inferredTemplateType, 'Llama3');

  const badMagic = new Uint8Array(valid);
  badMagic[0] = 0x42;
  assert.throws(() => parseGgufHeader(badMagic, 100, 'bad.gguf'), /Invalid GGUF format/);

  assert.throws(() => parseGgufHeader(valid.subarray(0, 10), 10, 'trunc.gguf'), /Unexpected EOF/);
});

test('SSE line parser handles delta chunks, finish reasons, and [DONE]', () => {
  assert.equal(parseSseLine(''), null);
  assert.equal(parseSseLine(': keep-alive'), null);
  assert.deepEqual(
    parseSseLine('data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}'),
    { deltaContent: 'Hello ', stopReason: undefined },
  );
  assert.deepEqual(parseSseLine('data: [DONE]'), { stopReason: 'done' });
});

test('consumeSseStream flushes trailing buffered SSE line without trailing newline', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    encoder.encode('data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}\n'),
    encoder.encode('data: {"choices":[{"delta":{"content":"world"},"finish_reason":"length"}]}'),
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  const tokens: string[] = [];
  let completed: { totalTokens: number; stopReason: string } | null = null;
  let cancelled = false;
  let errorMsg: string | null = null;

  await consumeSseStream(stream, new AbortController().signal, {
    onToken: (tok) => tokens.push(tok),
    onComplete: (totalTokens, stopReason) => {
      completed = { totalTokens, stopReason };
    },
    onCancelled: () => {
      cancelled = true;
    },
    onError: (msg) => {
      errorMsg = msg;
    },
  });

  assert.deepEqual(tokens, ['Hello ', 'world']);
  assert.deepEqual(completed, { totalTokens: 2, stopReason: 'max_tokens' });
  assert.equal(cancelled, false);
  assert.equal(errorMsg, null);
});

test('consumeSseStream flushes trailing [DONE] marker and split multi-byte UTF-8', async () => {
  const encoder = new TextEncoder();
  const fullPayload =
    'data: {"choices":[{"delta":{"content":"Hi 🚀"},"finish_reason":null}]}\n' +
    'data: [DONE]';
  const bytes = encoder.encode(fullPayload);
  const splitAt = fullPayload.indexOf('🚀') + 2; // split mid-emoji UTF-8 sequence

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, splitAt));
      controller.enqueue(bytes.subarray(splitAt));
      controller.close();
    },
  });

  const tokens: string[] = [];
  let completed: { totalTokens: number; stopReason: string } | null = null;

  await consumeSseStream(stream, new AbortController().signal, {
    onToken: (tok) => tokens.push(tok),
    onComplete: (totalTokens, stopReason) => {
      completed = { totalTokens, stopReason };
    },
    onCancelled: () => {},
    onError: () => {},
  });

  assert.deepEqual(tokens, ['Hi 🚀']);
  assert.deepEqual(completed, { totalTokens: 1, stopReason: 'done' });
});

test('parseSseLine extracts reasoning_content, reasoning, usage tokens, and error payloads', () => {
  assert.deepEqual(
    parseSseLine('data: {"choices":[{"delta":{"reasoning_content":"Step 1"},"finish_reason":null}]}'),
    { deltaContent: undefined, stopReason: undefined, deltaThinking: 'Step 1' },
  );
  assert.deepEqual(
    parseSseLine('data: {"choices":[{"delta":{"reasoning":"Step 2","content":"Ans"},"finish_reason":"stop"}],"usage":{"completion_tokens":42}}'),
    {
      deltaContent: 'Ans',
      stopReason: 'done',
      deltaThinking: 'Step 2',
      usageCompletionTokens: 42,
    },
  );
  assert.deepEqual(
    parseSseLine('data: {"error":{"message":"Model unloaded"}}'),
    { error: 'Model unloaded' },
  );
});

test('consumeSseStream routes reasoning_content and split <think> tags with live tok/s progress', async () => {
  const encoder = new TextEncoder();
  const sseLines = [
    'data: {"choices":[{"delta":{"reasoning_content":"First reason. "},"finish_reason":null}]}\n',
    'data: {"choices":[{"delta":{"content":"<thi"},"finish_reason":null}]}\n',
    'data: {"choices":[{"delta":{"content":"nk>Hidden thought</thi"},"finish_reason":null}]}\n',
    'data: {"choices":[{"delta":{"content":"nk>Visible answer."},"finish_reason":"stop"}],"usage":{"completion_tokens":18}}\n',
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of sseLines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });

  const contentTokens: string[] = [];
  const thinkingTokens: string[] = [];
  const progressEvents: GenerationProgress[] = [];
  let completed: {
    totalTokens: number;
    stopReason: string;
    tps?: number;
  } | null = null;

  await consumeSseStream(stream, new AbortController().signal, {
    onToken: (tok) => contentTokens.push(tok),
    onThinkingToken: (tok) => thinkingTokens.push(tok),
    onProgress: (p) => progressEvents.push(p),
    onComplete: (totalTokens, stopReason, stats) => {
      completed = { totalTokens, stopReason, tps: stats?.tokensPerSecond };
    },
    onCancelled: () => {},
    onError: () => {},
  });

  assert.equal(thinkingTokens.join(''), 'First reason. Hidden thought');
  assert.equal(contentTokens.join(''), 'Visible answer.');
  assert.ok(progressEvents.length >= 3);
  assert.ok(progressEvents.some((p) => p.isThinking));
  assert.ok(progressEvents.every((p) => p.tokensPerSecond > 0));
  assert.equal(completed?.totalTokens, 18);
  assert.equal(completed?.stopReason, 'done');
  assert.ok((completed?.tps ?? 0) > 0);
});

test('consumeSseStream invokes onError and suppresses onComplete on SSE error chunk', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode('data: {"error":{"message":"Context overflow in LM Studio"}}\n'),
      );
      controller.close();
    },
  });

  let errorMsg: string | null = null;
  let completedCalled = false;

  await consumeSseStream(stream, new AbortController().signal, {
    onToken: () => {},
    onComplete: () => {
      completedCalled = true;
    },
    onCancelled: () => {},
    onError: (msg) => {
      errorMsg = msg;
    },
  });

  assert.equal(errorMsg, 'Context overflow in LM Studio');
  assert.equal(completedCalled, false);
});
