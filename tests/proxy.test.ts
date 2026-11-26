import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createApiApp } from '../server.ts';
import {
  createLocalLlmProxyRouter,
  isLocalLoopbackEndpoint,
  normalizeLocalEndpoint,
  validateChatMessages,
} from '../server/localLlmProxy.ts';

async function listenServer(
  handler: http.RequestListener,
): Promise<{ server: http.Server; baseUrl: string; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}`, port };
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function getUnusedLoopbackPort(): Promise<number> {
  const probe = await listenServer((_req, res) => res.end());
  const port = probe.port;
  await closeServer(probe.server);
  return port;
}

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

test('server chat message validator accepts structured roles including tool calls/results and rejects malformed inputs', () => {
  const valid = validateChatMessages([
    { role: 'system', content: 'Follow pinned rules.' },
    { role: 'user', content: 'Hello' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'create_file', arguments: '{"filename":"a.rs","content":"fn main(){}"}' },
        },
      ],
    },
    { role: 'tool', content: '{"status":"ok"}', tool_call_id: 'call_1', name: 'create_file' },
  ]);
  assert.ok(valid);
  assert.equal(valid.length, 4);

  assert.equal(validateChatMessages([]), null);
  assert.equal(validateChatMessages('not-an-array'), null);
  assert.equal(validateChatMessages([{ role: 'admin', content: 'hack' }]), null);
  assert.equal(validateChatMessages([{ role: 'user', content: 123 }]), null);
  assert.equal(validateChatMessages([{ role: 'tool', content: 'ok' }]), null);
});

test('HTTP integration: /api/health, /api/local-llm/models, and /api/local-llm/chat (streaming, non-streaming, abort, and error handling)', async () => {
  let upstreamAborts = 0;
  let lastChatPayload: Record<string, unknown> | null = null;

  const mockLlm = await listenServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }, { id: 'llama-3.2-3b' }] }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        lastChatPayload = parsed;

        if (parsed.stream === false) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-nonstream',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Non-streaming reply' },
                  finish_reason: 'stop',
                },
              ],
            }),
          );
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
        });

        const holdOpen = parsed.model === 'slow-abort-test';
        let closed = false;
        res.on('close', () => {
          if (!res.writableEnded) {
            closed = true;
            upstreamAborts += 1;
            res.end();
          }
        });

        res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
        if (holdOpen) {
          return;
        }

        setTimeout(() => {
          if (closed || res.writableEnded) return;
          res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
          setTimeout(() => {
            if (closed || res.writableEnded) return;
            res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          }, 15);
        }, 15);
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  const apiApp = createApiApp();
  const proxyServer = await listenServer(apiApp);

  // Also verify mounting createLocalLlmProxyRouter directly with express.json({ strict: false })
  const directApp = express();
  directApp.use(express.json({ strict: false }));
  directApp.use('/api/local-llm', createLocalLlmProxyRouter());
  const directServer = await listenServer(directApp);

  try {
    // 1. /api/health
    const healthResp = await fetch(`${proxyServer.baseUrl}/api/health`);
    assert.equal(healthResp.status, 200);
    assert.deepEqual(await healthResp.json(), { status: 'ok', app: 'LowCon' });

    // 2. /api/local-llm/models -> 200
    const modelsOk = await fetch(`${proxyServer.baseUrl}/api/local-llm/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: mockLlm.baseUrl }),
    });
    assert.equal(modelsOk.status, 200);
    assert.deepEqual(await modelsOk.json(), {
      endpoint: `${mockLlm.baseUrl}/v1`,
      models: ['qwen2.5-7b-instruct', 'llama-3.2-3b'],
    });

    // 3. /api/local-llm/models -> 403 remote
    const modelsRemote = await fetch(`${proxyServer.baseUrl}/api/local-llm/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://api.openai.com/v1' }),
    });
    assert.equal(modelsRemote.status, 403);
    const remoteJson = (await modelsRemote.json()) as { error: string };
    assert.match(remoteJson.error, /privacy boundary/i);

    // 4. /api/local-llm/models -> 502 unreachable
    const deadPort = await getUnusedLoopbackPort();
    const modelsDead = await fetch(`${proxyServer.baseUrl}/api/local-llm/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: `http://127.0.0.1:${deadPort}/v1` }),
    });
    assert.equal(modelsDead.status, 502);

    // 5. /api/local-llm/chat -> streaming SSE chunks without premature abort (forwards tools & tool_choice)
    const streamResp = await fetch(`${proxyServer.baseUrl}/api/local-llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: mockLlm.baseUrl,
        model: 'qwen2.5-7b-instruct',
        messages: [{ role: 'user', content: 'Say hi' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'create_file',
              description: 'Create file',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        tool_choice: 'auto',
      }),
    });
    assert.equal(streamResp.status, 200);
    assert.match(streamResp.headers.get('content-type') ?? '', /^text\/event-stream/i);
    const sseBody = await streamResp.text();
    assert.ok(sseBody.includes('"content":"Hello"'));
    assert.ok(sseBody.includes('"content":" world"'));
    assert.ok(sseBody.includes('data: [DONE]'));
    assert.equal(upstreamAborts, 0);
    assert.equal(lastChatPayload?.stream, true);
    assert.equal(Array.isArray(lastChatPayload?.tools), true);
    assert.equal(lastChatPayload?.tool_choice, 'auto');

    // 6. /api/local-llm/chat -> non-streaming JSON
    const nonStreamResp = await fetch(`${proxyServer.baseUrl}/api/local-llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: mockLlm.baseUrl,
        model: 'qwen2.5-7b-instruct',
        stream: false,
        messages: [{ role: 'user', content: 'Say hi once' }],
      }),
    });
    assert.equal(nonStreamResp.status, 200);
    assert.match(nonStreamResp.headers.get('content-type') ?? '', /application\/json/i);
    const nonStreamJson = (await nonStreamResp.json()) as {
      id: string;
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(nonStreamJson.id, 'chatcmpl-nonstream');
    assert.equal(nonStreamJson.choices[0]?.message.content, 'Non-streaming reply');
    assert.equal(lastChatPayload?.stream, false);

    // 7. Client disconnect mid-stream aborts upstream request
    const abortController = new AbortController();
    const abortedResp = await fetch(`${proxyServer.baseUrl}/api/local-llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: mockLlm.baseUrl,
        model: 'slow-abort-test',
        messages: [{ role: 'user', content: 'Wait and abort' }],
      }),
      signal: abortController.signal,
    });
    assert.equal(abortedResp.status, 200);
    const reader = abortedResp.body?.getReader();
    assert.ok(reader);
    const firstChunk = await reader.read();
    assert.equal(firstChunk.done, false);
    abortController.abort();
    await reader.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(upstreamAborts, 1);

    // 8. Invalid messages, array body, null body, malformed JSON (400), and >2MB payload (413)
    const invalidMsgs = await fetch(`${proxyServer.baseUrl}/api/local-llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: mockLlm.baseUrl, messages: [] }),
    });
    assert.equal(invalidMsgs.status, 400);

    const arrayBody = await fetch(`${proxyServer.baseUrl}/api/local-llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(['not', 'an', 'object']),
    });
    assert.equal(arrayBody.status, 400);

    const nullBodyDirect = await fetch(`${directServer.baseUrl}/api/local-llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    });
    assert.equal(nullBodyDirect.status, 400);

    const nullModelsDirect = await fetch(`${directServer.baseUrl}/api/local-llm/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    });
    assert.equal(nullModelsDirect.status, 400);

    const malformedJson = await fetch(`${proxyServer.baseUrl}/api/local-llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json',
    });
    assert.equal(malformedJson.status, 400);
    assert.match(malformedJson.headers.get('content-type') ?? '', /application\/json/i);

    const oversizedPayload = JSON.stringify({
      endpoint: mockLlm.baseUrl,
      messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024 + 1024) }],
    });
    const tooLarge = await fetch(`${proxyServer.baseUrl}/api/local-llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversizedPayload,
    });
    assert.equal(tooLarge.status, 413);
    assert.match(tooLarge.headers.get('content-type') ?? '', /application\/json/i);
  } finally {
    await closeServer(directServer.server);
    await closeServer(proxyServer.server);
    await closeServer(mockLlm.server);
  }
});
