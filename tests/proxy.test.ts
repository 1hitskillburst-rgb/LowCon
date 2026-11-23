import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLocalLoopbackEndpoint,
  normalizeLocalEndpoint,
  validateChatMessages,
} from '../server/localLlmProxy.ts';

test('server loopback proxy allows only local loopback addresses and rejects remote/private/metadata hosts', () => {
  assert.equal(isLocalLoopbackEndpoint('http://127.0.0.1:1234/v1'), true);
  assert.equal(isLocalLoopbackEndpoint('http://localhost:11434/v1'), true);
  assert.equal(isLocalLoopbackEndpoint('http://[::1]:8080/v1'), true);
  assert.equal(isLocalLoopbackEndpoint('127.0.0.1:1234'), true);

  // Reject remote, cloud metadata, LAN, wildcard bind, non-HTTP schemes, and embedded credentials
  assert.equal(isLocalLoopbackEndpoint('https://api.openai.com/v1'), false);
  assert.equal(isLocalLoopbackEndpoint('http://169.254.169.254/latest/meta-data/'), false);
  assert.equal(isLocalLoopbackEndpoint('http://192.168.1.10:1234/v1'), false);
  assert.equal(isLocalLoopbackEndpoint('http://10.0.0.5:1234/v1'), false);
  assert.equal(isLocalLoopbackEndpoint('http://0.0.0.0:1234/v1'), false);
  assert.equal(isLocalLoopbackEndpoint('file:///etc/passwd'), false);
  assert.equal(isLocalLoopbackEndpoint('http://user:pass@127.0.0.1:1234/v1'), false);
  assert.equal(isLocalLoopbackEndpoint(''), false);

  assert.equal(normalizeLocalEndpoint('127.0.0.1:1234'), 'http://127.0.0.1:1234/v1');
  assert.equal(normalizeLocalEndpoint('http://localhost:1234/'), 'http://localhost:1234/v1');
});

test('server chat message validator accepts structured roles and rejects malformed inputs', () => {
  const valid = validateChatMessages([
    { role: 'system', content: 'Follow pinned rules.' },
    { role: 'user', content: 'Hello' },
  ]);
  assert.ok(valid);
  assert.equal(valid.length, 2);

  assert.equal(validateChatMessages([]), null);
  assert.equal(validateChatMessages('not-an-array'), null);
  assert.equal(validateChatMessages([{ role: 'admin', content: 'hack' }]), null);
  assert.equal(validateChatMessages([{ role: 'user', content: 123 }]), null);
});
