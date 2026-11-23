const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

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
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request payload exceeds 2MB limit.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function validateMessages(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 500) return null;
  const roles = new Set(['system', 'user', 'assistant']);
  const out = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') return null;
    if (typeof item.role !== 'string' || !roles.has(item.role)) return null;
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
      if (item && typeof item.name === 'string') models.push(item.name);
      else if (item && typeof item.id === 'string') models.push(item.id);
    }
  }
  return models;
}

async function handleModelsProxy(req, res) {
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
    const primaryUrl = `${base}/models`;
    const fallbackUrl = base.endsWith('/v1') ? `${base.slice(0, -3)}/models` : primaryUrl;
    const urls = primaryUrl === fallbackUrl ? [primaryUrl] : [primaryUrl, fallbackUrl];

    let upstream = null;
    let lastErr = '';
    for (const url of urls) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const r = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (r.ok) {
          upstream = r;
          break;
        }
        lastErr = `HTTP ${r.status} from ${url}`;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
    }

    if (!upstream) {
      sendJson(res, 502, {
        error: `Failed to connect to local server at ${primaryUrl}: ${lastErr}. Is LM Studio's Local Server running?`,
      });
      return;
    }

    const payload = await upstream.json();
    sendJson(res, 200, { endpoint: base, models: extractModels(payload) });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleChatProxy(req, res) {
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

    const base = normalizeLocalEndpoint(endpoint);
    const url = `${base}/chat/completions`;
    const controller = new AbortController();
    req.on('close', () => controller.abort());

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
            ? Math.min(32768, Math.max(16, Math.floor(body.max_tokens)))
            : 512,
        stream: true,
        stop: Array.isArray(body.stop)
          ? body.stop.filter((s) => typeof s === 'string' && s.length > 0).slice(0, 8)
          : undefined,
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

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
    } else {
      res.end();
    }
  }
}

function startDesktopServer(distDir) {
  const resolvedDist = path.resolve(distDir);
  const indexHtml = path.join(resolvedDist, 'index.html');

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];

      if (urlPath === '/api/health' && req.method === 'GET') {
        sendJson(res, 200, { status: 'ok', runtime: 'desktop' });
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

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const candidate = path.resolve(resolvedDist, rel);
      const isInsideDist =
        candidate === resolvedDist || candidate.startsWith(resolvedDist + path.sep);

      const filePath =
        isInsideDist && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
          ? candidate
          : indexHtml;

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.statusCode = 200;
        res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
        res.end(data);
      });
    });

    server.on('error', reject);
    // Strictly bind 127.0.0.1 on an ephemeral OS port so only this desktop window can reach it
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}`,
      });
    });
  });
}

module.exports = { startDesktopServer };
