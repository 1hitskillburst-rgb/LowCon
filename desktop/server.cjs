const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const DEFAULT_DESKTOP_PORTS = [41735, 41736, 41737, 41738, 41739, 0];

let lastTrackedEndpoint = '';
const lastTrackedModels = new Set();

function recordTrackedLocalEndpoint(endpoint, model) {
  if (isLocalLoopbackEndpoint(endpoint)) {
    lastTrackedEndpoint = normalizeLocalEndpoint(endpoint);
  }
  if (typeof model === 'string' && model.trim()) {
    lastTrackedModels.add(model.trim());
  }
}

async function fetchLoadedInstanceIds(origin, timeoutMs = 1500) {
  for (const url of [`${origin}/api/v1/models`, `${origin}/api/v0/models`]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => {});
        continue;
      }
      const payload = await resp.json();
      const ids = [];
      if (payload && Array.isArray(payload.models)) {
        for (const m of payload.models) {
          if (m && Array.isArray(m.loaded_instances)) {
            for (const inst of m.loaded_instances) {
              if (inst && typeof inst.id === 'string' && inst.id.trim()) {
                ids.push(inst.id.trim());
              }
            }
          }
        }
      }
      if (payload && Array.isArray(payload.data)) {
        for (const item of payload.data) {
          if (item && typeof item.id === 'string' && item.id.trim() && (!item.state || item.state === 'loaded')) {
            ids.push(item.id.trim());
          }
        }
      }
      return { restSupported: true, instanceIds: [...new Set(ids)] };
    } catch {
      // Try next endpoint
    } finally {
      clearTimeout(timer);
    }
  }
  return { restSupported: false, instanceIds: [] };
}

function runLmsUnloadAll(timeoutMs = 2500) {
  return new Promise((resolve) => {
    try {
      execFile('lms', ['unload', '--all'], { timeout: timeoutMs, windowsHide: true }, (err) => {
        resolve(!err);
      });
    } catch {
      resolve(false);
    }
  });
}

async function unloadAllLocalModels(rawEndpoint, fallbackModels = []) {
  const candidate = (typeof rawEndpoint === 'string' ? rawEndpoint.trim() : '') || lastTrackedEndpoint;
  if (!candidate || !isLocalLoopbackEndpoint(candidate)) {
    const cliFallbackUsed = await runLmsUnloadAll();
    return { ok: true, unloaded: [], cliFallbackUsed };
  }

  const normalized = normalizeLocalEndpoint(candidate);
  const origin = new URL(normalized).origin;
  const { restSupported, instanceIds } = await fetchLoadedInstanceIds(origin);

  const targets = restSupported
    ? instanceIds
    : [
        ...new Set([
          ...fallbackModels.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim()),
          ...lastTrackedModels,
        ]),
      ];

  const unloaded = [];
  let restFailed = false;

  if (targets.length > 0) {
    const results = await Promise.allSettled(
      targets.map(async (instanceId) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        try {
          const r = await fetch(`${origin}/api/v1/models/unload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instance_id: instanceId }),
            signal: controller.signal,
          });
          await r.body?.cancel().catch(() => {});
          if (r.ok) return instanceId;
          restFailed = true;
          return null;
        } catch {
          restFailed = true;
          return null;
        } finally {
          clearTimeout(timer);
        }
      }),
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        unloaded.push(r.value);
      }
    }
  }

  let cliFallbackUsed = false;
  if ((!restSupported || restFailed) && unloaded.length === 0) {
    cliFallbackUsed = await runLmsUnloadAll();
  }

  lastTrackedModels.clear();
  return { ok: true, endpoint: origin, unloaded, cliFallbackUsed };
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

function isLocalLoopbackEndpoint(rawEndpoint) {
  try {
    const trimmed = String(rawEndpoint || '').trim();
    if (!trimmed) return false;
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    const parsed = new URL(withProto);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return ALLOWED_LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function normalizeLocalEndpoint(rawEndpoint) {
  let trimmed = String(rawEndpoint || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) trimmed = `http://${trimmed}`;
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function sendJson(res, status, payload) {
  if (res.headersSent || res.destroyed) return;
  res.statusCode = status;
  if (status === 413) {
    res.setHeader('Connection', 'close');
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        req.resume();
        fail(new HttpError(413, 'Request body exceeds the 2MB limit.'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) {
          settled = true;
          resolve({});
          return;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          fail(new HttpError(400, 'Invalid request body: expected a JSON object.'));
          return;
        }
        settled = true;
        resolve(parsed);
      } catch {
        fail(new HttpError(400, 'Malformed JSON request body.'));
      }
    });

    req.on('error', (err) => fail(err));
  });
}

function validateToolCalls(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 32) return null;
  const out = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') return null;
    if (typeof item.id !== 'string' || !item.id.trim()) return null;
    if (item.type !== undefined && item.type !== 'function') return null;
    if (!item.function || typeof item.function !== 'object') return null;
    if (typeof item.function.name !== 'string' || !item.function.name.trim()) return null;
    if (typeof item.function.arguments !== 'string') return null;
    out.push({
      id: item.id,
      type: 'function',
      function: {
        name: item.function.name.trim(),
        arguments: item.function.arguments,
      },
    });
  }
  return out;
}

function validateTools(input) {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 32) return null;
  const out = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') return null;
    if (item.type !== 'function' || !item.function || typeof item.function !== 'object') return null;
    if (typeof item.function.name !== 'string' || !item.function.name.trim()) return null;
    if (item.function.description !== undefined && typeof item.function.description !== 'string') {
      return null;
    }
    if (
      item.function.parameters !== undefined &&
      (!item.function.parameters ||
        typeof item.function.parameters !== 'object' ||
        Array.isArray(item.function.parameters))
    ) {
      return null;
    }
    out.push({
      type: 'function',
      function: {
        name: item.function.name.trim(),
        ...(typeof item.function.description === 'string'
          ? { description: item.function.description }
          : {}),
        ...(item.function.parameters ? { parameters: item.function.parameters } : {}),
      },
    });
  }
  return out;
}

function validateToolChoice(input) {
  if (input === undefined) return undefined;
  if (typeof input === 'string') {
    return input === 'auto' || input === 'none' || input === 'required' ? input : undefined;
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    if (
      input.type === 'function' &&
      input.function &&
      typeof input.function.name === 'string' &&
      input.function.name.trim()
    ) {
      return { type: 'function', function: { name: input.function.name.trim() } };
    }
  }
  return undefined;
}

function validateMessages(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 500) return null;
  const roles = new Set(['system', 'user', 'assistant', 'tool']);
  const out = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') return null;
    if (typeof item.role !== 'string' || !roles.has(item.role)) return null;

    if (item.role === 'tool') {
      if (typeof item.content !== 'string') return null;
      if (typeof item.tool_call_id !== 'string' || !item.tool_call_id.trim()) return null;
      out.push({
        role: 'tool',
        content: item.content,
        tool_call_id: item.tool_call_id,
        ...(typeof item.name === 'string' && item.name.trim() ? { name: item.name.trim() } : {}),
      });
      continue;
    }

    if (item.role === 'assistant' && item.tool_calls !== undefined) {
      const toolCalls = validateToolCalls(item.tool_calls);
      if (!toolCalls) return null;
      if (item.content !== undefined && item.content !== null && typeof item.content !== 'string') {
        return null;
      }
      out.push({
        role: 'assistant',
        content: typeof item.content === 'string' ? item.content : null,
        tool_calls: toolCalls,
      });
      continue;
    }

    if (typeof item.content !== 'string') return null;
    out.push({ role: item.role, content: item.content });
  }
  return out;
}

function extractModels(payload) {
  const models = [];
  if (!payload || typeof payload !== 'object') return models;
  if (Array.isArray(payload.data)) {
    for (const item of payload.data) {
      if (typeof item === 'string') models.push(item);
      else if (item && typeof item.id === 'string') models.push(item.id);
    }
  } else if (Array.isArray(payload.models)) {
    for (const item of payload.models) {
      if (typeof item === 'string') models.push(item);
      else if (item && typeof item.name === 'string') models.push(item.name);
      else if (item && typeof item.id === 'string') models.push(item.id);
    }
  } else if (Array.isArray(payload)) {
    for (const item of payload) {
      if (typeof item === 'string') models.push(item);
      else if (item && typeof item.id === 'string') models.push(item.id);
    }
  }
  return models;
}

async function handleModelsProxy(req, res) {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  };
  res.on('close', onClose);

  try {
    const body = await readJsonBody(req);
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
    if (!isLocalLoopbackEndpoint(endpoint)) {
      sendJson(res, 403, {
        error: `LowCon privacy boundary: Remote endpoint '${endpoint}' rejected. Only local loopback addresses (127.0.0.1 / localhost / ::1) are permitted.`,
      });
      return;
    }

    const base = normalizeLocalEndpoint(endpoint);
    recordTrackedLocalEndpoint(base);
    const primaryUrl = `${base}/models`;
    const fallbackUrl = base.endsWith('/v1') ? `${base.slice(0, -3)}/models` : primaryUrl;
    const urls = primaryUrl === fallbackUrl ? [primaryUrl] : [primaryUrl, fallbackUrl];

    let upstream = null;
    let lastErr = '';
    for (const url of urls) {
      if (controller.signal.aborted) break;
      const attemptController = new AbortController();
      const onParentAbort = () => attemptController.abort();
      controller.signal.addEventListener('abort', onParentAbort, { once: true });
      const timer = setTimeout(() => attemptController.abort(), 5000);
      try {
        const r = await fetch(url, { signal: attemptController.signal });
        if (r.ok) {
          upstream = r;
          break;
        }
        await r.body?.cancel().catch(() => {});
        lastErr = `HTTP ${r.status} from ${url}`;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onParentAbort);
      }
    }

    if (!upstream) {
      sendJson(res, 502, {
        error: `Failed to connect to local server at ${primaryUrl}: ${lastErr}. Is LM Studio's Local Server running?`,
      });
      return;
    }

    let payload;
    try {
      payload = await upstream.json();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 502, {
        error: `Invalid JSON response from local server at ${primaryUrl}: ${msg}`,
      });
      return;
    }

    sendJson(res, 200, { endpoint: base, models: extractModels(payload) });
  } catch (err) {
    const status = err instanceof HttpError ? err.statusCode : 500;
    sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    res.off('close', onClose);
  }
}

async function handleChatProxy(req, res) {
  const controller = new AbortController();
  const onResponseClose = () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  };
  res.on('close', onResponseClose);

  try {
    const body = await readJsonBody(req);
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
    if (!isLocalLoopbackEndpoint(endpoint)) {
      sendJson(res, 403, {
        error: `LowCon privacy boundary: Remote endpoint '${endpoint}' rejected. Only local loopback addresses (127.0.0.1 / localhost / ::1) are permitted.`,
      });
      return;
    }

    const messages = validateMessages(body.messages);
    if (!messages) {
      sendJson(res, 400, { error: 'Invalid chat payload: messages array is required.' });
      return;
    }

    if (body.stream !== undefined && typeof body.stream !== 'boolean') {
      sendJson(res, 400, { error: 'Invalid chat payload: stream must be a boolean.' });
      return;
    }

    const stream = body.stream !== false;
    const base = normalizeLocalEndpoint(endpoint);
    const modelName = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'local-model';
    recordTrackedLocalEndpoint(base, modelName);
    const url = `${base}/chat/completions`;
    const allowedEfforts = new Set(['low', 'medium', 'high', 'xhigh']);
    const reasoningEffort =
      typeof body.reasoning_effort === 'string' && allowedEfforts.has(body.reasoning_effort)
        ? body.reasoning_effort
        : undefined;
    const tools = validateTools(body.tools);
    if (tools === null) {
      sendJson(res, 400, { error: 'Invalid chat payload: malformed tools array.' });
      return;
    }
    const toolChoice = tools && tools.length > 0 ? validateToolChoice(body.tool_choice) : undefined;

    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'local-model',
        messages,
        temperature:
          typeof body.temperature === 'number' && Number.isFinite(body.temperature)
            ? Math.min(2, Math.max(0, body.temperature))
            : 0.7,
        top_p:
          typeof body.top_p === 'number' && Number.isFinite(body.top_p)
            ? Math.min(1, Math.max(0.01, body.top_p))
            : 0.9,
        max_tokens:
          typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens)
            ? Math.min(131072, Math.max(16, Math.floor(body.max_tokens)))
            : 512,
        stream,
        stop: Array.isArray(body.stop)
          ? body.stop.filter((s) => typeof s === 'string' && s.length > 0).slice(0, 8)
          : undefined,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
      }),
      signal: controller.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      sendJson(res, upstream.status || 502, {
        error: `Local server ${url} returned HTTP ${upstream.status}: ${text.slice(0, 200)}`,
      });
      return;
    }

    const upstreamContentType = (upstream.headers.get('content-type') || '').toLowerCase();
    if (!stream || upstreamContentType.includes('application/json')) {
      const text = await upstream.text();
      let jsonPayload;
      try {
        jsonPayload = JSON.parse(text);
      } catch {
        sendJson(res, 502, { error: `Local server ${url} returned invalid JSON.` });
        return;
      }
      sendJson(res, 200, jsonPayload);
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const reader = upstream.body.getReader();
    try {
      while (true) {
        if (res.writableEnded || res.destroyed) {
          await reader.cancel().catch(() => {});
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          res.write(Buffer.from(value));
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (!res.writableEnded) {
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) {
      const status = err instanceof HttpError ? err.statusCode : 502;
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    res.off('close', onResponseClose);
  }
}

function getPreferredPorts(options = {}) {
  if (typeof options.port === 'number' && Number.isInteger(options.port) && options.port >= 0) {
    return [options.port];
  }
  const envPortRaw = process.env.LOWCON_DESKTOP_PORT;
  if (envPortRaw) {
    const envPort = Number(envPortRaw);
    if (Number.isInteger(envPort) && envPort > 0 && envPort <= 65535) {
      return [envPort, ...DEFAULT_DESKTOP_PORTS.filter((p) => p !== envPort)];
    }
  }
  return DEFAULT_DESKTOP_PORTS;
}

function listenOnPreferredPorts(server, ports) {
  return new Promise((resolve, reject) => {
    let idx = 0;

    const tryNext = () => {
      if (idx >= ports.length) {
        reject(new Error('Failed to bind any local loopback port for LowCon desktop server.'));
        return;
      }
      const port = ports[idx++];
      const onError = (err) => {
        server.off('listening', onListening);
        if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && idx < ports.length) {
          tryNext();
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        const addr = server.address();
        resolve({
          server,
          port: addr.port,
          url: `http://127.0.0.1:${addr.port}`,
        });
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    };

    tryNext();
  });
}

function startDesktopServer(distDir, options = {}) {
  const resolvedDist = path.resolve(distDir);
  const indexHtml = path.join(resolvedDist, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    return Promise.reject(
      new Error(`Desktop build not found at ${resolvedDist}. Run "npm run build" first.`),
    );
  }

  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

    if (urlPath === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok', app: 'LowCon', runtime: 'desktop' });
      return;
    }
    if (urlPath === '/api/local-llm/models' && req.method === 'POST') {
      void handleModelsProxy(req, res);
      return;
    }
    if (urlPath === '/api/local-llm/chat' && req.method === 'POST') {
      void handleChatProxy(req, res);
      return;
    }
    if (urlPath === '/api/local-llm/unload-all' && req.method === 'POST') {
      void handleUnloadAllProxy(req, res);
      return;
    }
    if (urlPath === '/api' || urlPath.startsWith('/api/')) {
      sendJson(res, 404, { error: `API route not found: ${req.method} ${urlPath}` });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(urlPath);
    } catch {
      sendJson(res, 400, { error: 'Malformed URL encoding' });
      return;
    }

    if (decodedPath.includes('\0')) {
      sendJson(res, 400, { error: 'Invalid request path' });
      return;
    }

    const rel = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
    const candidate = path.resolve(resolvedDist, rel);
    const isInsideDist =
      candidate === resolvedDist || candidate.startsWith(resolvedDist + path.sep);
    if (!isInsideDist) {
      sendJson(res, 403, { error: 'Forbidden' });
      return;
    }

    let filePath = indexHtml;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        filePath = candidate;
      }
    } catch {
      filePath = indexHtml;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
      res.setHeader('Content-Length', data.length);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(data);
    });
  });

  return listenOnPreferredPorts(server, getPreferredPorts(options));
}

async function handleUnloadAllProxy(req, res) {
  try {
    const body = await readJsonBody(req);
    const rawEndpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    if (rawEndpoint && !isLocalLoopbackEndpoint(rawEndpoint)) {
      sendJson(res, 403, {
        error: `LowCon privacy boundary: Remote endpoint '${rawEndpoint}' rejected. Only local loopback addresses (127.0.0.1 / localhost / ::1) are permitted.`,
      });
      return;
    }
    const fallbackModels = Array.isArray(body.models)
      ? body.models.filter((m) => typeof m === 'string' && m.trim()).slice(0, 32)
      : [];
    const result = await unloadAllLocalModels(rawEndpoint || undefined, fallbackModels);
    sendJson(res, 200, result);
  } catch (err) {
    const status = err instanceof HttpError ? err.statusCode : 500;
    sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
  }
}

module.exports = {
  startDesktopServer,
  unloadAllLocalModels,
  extractModels,
  isLocalLoopbackEndpoint,
  normalizeLocalEndpoint,
  validateMessages,
};
