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
import {
  clearActiveVaultKey,
  createDefaultSettings,
  createDefaultWorkspace,
  disableVaultEncryption,
  isVaultModeActive,
  isVaultSealed,
  loadSavedThemePreference,
  lockActiveVaultNow,
  persistActiveWorkspace,
  resetAndWipeVault,
  saveThemePreference,
  sealWorkspaceVault,
  unsealWorkspaceVault,
} from '../src/core/storage';
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

  // Expanded redaction covers JSON-formatted secrets, Authorization headers, and provider keys
  const jsonSanitized = sanitizeDiagnosticMessage(
    '{"api_key":"sk-live-secret999999999999","password":"hunter2","prompt":"confidential"} Authorization: Bearer tok_secret_123 AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz123456',
  );
  assert.equal(jsonSanitized.includes('sk-live-secret'), false);
  assert.equal(jsonSanitized.includes('hunter2'), false);
  assert.equal(jsonSanitized.includes('confidential'), false);
  assert.equal(jsonSanitized.includes('tok_secret_123'), false);
  assert.equal(jsonSanitized.includes('AIzaSy'), false);

  // Diagnostic logging defaults to disabled for privacy-by-default
  assert.equal(createDefaultSettings().diagnosticLevel, 'disabled');

  // Safe char truncation never splits multi-byte emoji
  const trunc = safeTruncateChars('Hello 🚀🔥✨ world with unicode — emdash', 12);
  assert.equal(Array.from(trunc).length, 12);
});

test('continuous encrypted vault keeps data encrypted at rest after unlock and supports relock/disable/reset', async () => {
  const store = new Map<string, string>();
  const fakeStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    value: fakeStorage,
    configurable: true,
    writable: true,
  });

  const logger = new DiagnosticLogger('disabled');
  try {
    clearActiveVaultKey();
    const initial = createDefaultWorkspace();
    initial.settings.theme = {
      preset: 'black',
      bg: '#0D0E11',
      surface: '#16181D',
      sidebar: '#121318',
      accent: '#6E82FF',
    };
    initial.sessions[0].title = 'Top Secret Design';

    // Seal vault -> ciphertext stored, plaintext purged, theme hint saved
    const sealed = await sealWorkspaceVault(initial, 'CorrectHorse#2026', logger);
    assert.equal(sealed.ok, true);
    assert.equal(isVaultSealed(), true);
    assert.equal(isVaultModeActive(), false);
    assert.equal(store.get('lowcon.workspace.v1'), undefined);
    assert.ok(store.get('lowcon.vault.sealed.v1'));
    assert.equal(store.get('lowcon.vault.sealed.v1')?.includes('Top Secret Design'), false);
    assert.equal(loadSavedThemePreference().preset, 'black');

    // Unlock vault -> stays encrypted at rest, NEVER writes plaintext key
    const unlocked = await unsealWorkspaceVault('CorrectHorse#2026', logger);
    assert.equal(unlocked.ok, true);
    assert.equal(isVaultModeActive(), true);
    assert.equal(store.get('lowcon.workspace.v1'), undefined);
    if (!unlocked.ok) return;
    assert.equal(unlocked.workspace.sessions[0].title, 'Top Secret Design');

    // Mutate and persist while unlocked -> re-encrypts directly into sealed vault key
    const updated = {
      ...unlocked.workspace,
      sessions: unlocked.workspace.sessions.map((s, idx) =>
        idx === 0 ? { ...s, title: 'Updated Secret Session' } : s,
      ),
    };
    const persisted = await persistActiveWorkspace(updated, logger);
    assert.equal(persisted.ok, true);
    assert.equal(store.get('lowcon.workspace.v1'), undefined);
    assert.equal(store.get('lowcon.vault.sealed.v1')?.includes('Updated Secret Session'), false);

    // 1-click lock clears in-memory key; re-unlocking sees updated session
    const relocked = await lockActiveVaultNow(updated, logger);
    assert.equal(relocked.ok, true);
    assert.equal(isVaultModeActive(), false);

    const unlockedAgain = await unsealWorkspaceVault('CorrectHorse#2026', logger);
    assert.equal(unlockedAgain.ok, true);
    if (!unlockedAgain.ok) return;
    assert.equal(unlockedAgain.workspace.sessions[0].title, 'Updated Secret Session');

    // Explicit opt-out restores plaintext storage and removes sealed vault
    const disabled = disableVaultEncryption(unlockedAgain.workspace, logger);
    assert.equal(disabled.ok, true);
    assert.equal(isVaultModeActive(), false);
    assert.equal(isVaultSealed(), false);
    assert.ok(store.get('lowcon.workspace.v1')?.includes('Updated Secret Session'));

    // Re-seal then test recovery reset (preserves theme, wipes sealed vault)
    saveThemePreference(initial.settings.theme);
    await sealWorkspaceVault(updated, 'CorrectHorse#2026', logger);
    assert.equal(isVaultSealed(), true);
    const fresh = resetAndWipeVault(logger);
    assert.equal(isVaultSealed(), false);
    assert.equal(isVaultModeActive(), false);
    assert.equal(fresh.settings.theme.preset, 'black');
    assert.notEqual(fresh.sessions[0].title, 'Updated Secret Session');
  } finally {
    clearActiveVaultKey();
    if (prevStorage) {
      Object.defineProperty(globalThis, 'localStorage', prevStorage);
    } else {
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  }
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
