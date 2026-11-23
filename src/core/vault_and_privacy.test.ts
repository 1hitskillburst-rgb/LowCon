import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DiagnosticLogger,
  isLocalEndpoint,
  normalizeApiEndpoint,
  safeTruncateChars,
  sanitizeDiagnosticMessage,
} from './privacy';
import { decryptVaultString, encryptVaultString, VaultError } from './vault';
import { createMockGgufBytes, parseGgufHeader } from './gguf';
import { parseSseLine } from './inference';

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
