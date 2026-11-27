import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';

const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

let lastTrackedEndpoint = '';
const lastTrackedModels = new Set<string>();

export function recordTrackedLocalEndpoint(endpoint: string, model?: string): void {
  if (isLocalLoopbackEndpoint(endpoint)) {
    lastTrackedEndpoint = normalizeLocalEndpoint(endpoint);
  }
  if (model && model.trim()) {
    lastTrackedModels.add(model.trim());
  }
}

async function fetchLoadedInstanceIds(
  origin: string,
  timeoutMs = 1500,
): Promise<{ restSupported: boolean; instanceIds: string[] }> {
  for (const url of [`${origin}/api/v1/models`, `${origin}/api/v0/models`]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal, redirect: 'error' });
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => {});
        continue;
      }
      const payload = (await resp.json()) as {
        models?: Array<{
          loaded_instances?: Array<{ id?: unknown }>;
        }>;
        data?: Array<{ id?: unknown; state?: unknown }>;
      };
      const ids: string[] = [];
      if (Array.isArray(payload.models)) {
        for (const m of payload.models) {
          if (Array.isArray(m?.loaded_instances)) {
            for (const inst of m.loaded_instances) {
              if (typeof inst?.id === 'string' && inst.id.trim()) {
                ids.push(inst.id.trim());
              }
            }
          }
        }
      }
      if (Array.isArray(payload.data)) {
        for (const item of payload.data) {
          if (
            item &&
            typeof item.id === 'string' &&
            item.id.trim() &&
            (!item.state || item.state === 'loaded')
          ) {
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

function runLmsUnloadAll(timeoutMs = 2500): Promise<boolean> {
  const candidates = ['lms'];
  const homeBin = path.join(
    os.homedir(),
    '.lmstudio',
    'bin',
    process.platform === 'win32' ? 'lms.exe' : 'lms',
  );
  if (fs.existsSync(homeBin)) {
    candidates.push(homeBin);
  }

  return new Promise((resolve) => {
    let idx = 0;
    const tryNext = () => {
      if (idx >= candidates.length) {
        resolve(false);
        return;
      }
      const bin = candidates[idx++];
      try {
        execFile(bin, ['unload', '--all'], { timeout: timeoutMs, windowsHide: true }, (err) => {
          if (!err) {
            resolve(true);
            return;
          }
          tryNext();
        });
      } catch {
        tryNext();
      }
    };
    tryNext();
  });
}

export async function unloadAllLocalModels(
  rawEndpoint?: string,
  fallbackModels: string[] = [],
): Promise<{ ok: boolean; endpoint?: string; unloaded: string[]; cliFallbackUsed: boolean }> {
  const candidate = rawEndpoint?.trim() || lastTrackedEndpoint;
  if (!candidate || !isLocalLoopbackEndpoint(candidate)) {
    const cliUsed = await runLmsUnloadAll();
    return { ok: true, unloaded: [], cliFallbackUsed: cliUsed };
  }

  const normalized = normalizeLocalEndpoint(candidate);
  const origin = new URL(normalized).origin;
  const { restSupported, instanceIds } = await fetchLoadedInstanceIds(origin);

  const targets = restSupported
    ? instanceIds
    : [...new Set([...fallbackModels.map((m) => m.trim()).filter(Boolean), ...lastTrackedModels])];

  const unloaded: string[] = [];
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
            redirect: 'error',
          });
          await r.body?.cancel().catch(() => {});
          if (r.ok) {
            return instanceId;
          }
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
  if (!restSupported || restFailed) {
    cliFallbackUsed = await runLmsUnloadAll();
  }

  lastTrackedModels.clear();
  return { ok: true, endpoint: origin, unloaded, cliFallbackUsed };
}

export function isLocalLoopbackEndpoint(rawEndpoint: string): boolean {
  try {
    const trimmed = rawEndpoint.trim();
    if (!trimmed) return false;
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    const parsed = new URL(withProto);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    if (parsed.username || parsed.password) {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_LOOPBACK_HOSTS.has(host);
  } catch {
    return false;
  }
}

export function normalizeLocalEndpoint(rawEndpoint: string): string {
  let trimmed = rawEndpoint.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `http://${trimmed}`;
  }
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

interface SanitizedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface SanitizedChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: SanitizedToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface SanitizedToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

function validateToolCalls(input: unknown): SanitizedToolCall[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 32) {
    return null;
  }
  const out: SanitizedToolCall[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') return null;
    const rec = item as {
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    if (typeof rec.id !== 'string' || !rec.id.trim()) return null;
    if (rec.type !== undefined && rec.type !== 'function') return null;
    if (!rec.function || typeof rec.function !== 'object') return null;
    if (typeof rec.function.name !== 'string' || !rec.function.name.trim()) return null;
    if (typeof rec.function.arguments !== 'string') return null;
    out.push({
      id: rec.id,
      type: 'function',
      function: {
        name: rec.function.name.trim(),
        arguments: rec.function.arguments,
      },
    });
  }
  return out;
}

export function validateTools(input: unknown): SanitizedToolDefinition[] | undefined | null {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 32) return null;
  const out: SanitizedToolDefinition[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') return null;
    const rec = item as {
      type?: unknown;
      function?: { name?: unknown; description?: unknown; parameters?: unknown };
    };
    if (rec.type !== 'function' || !rec.function || typeof rec.function !== 'object') return null;
    if (typeof rec.function.name !== 'string' || !rec.function.name.trim()) return null;
    if (
      rec.function.description !== undefined &&
      typeof rec.function.description !== 'string'
    ) {
      return null;
    }
    if (
      rec.function.parameters !== undefined &&
      (!rec.function.parameters ||
        typeof rec.function.parameters !== 'object' ||
        Array.isArray(rec.function.parameters))
    ) {
      return null;
    }
    out.push({
      type: 'function',
      function: {
        name: rec.function.name.trim(),
        ...(typeof rec.function.description === 'string'
          ? { description: rec.function.description }
          : {}),
        ...(rec.function.parameters
          ? { parameters: rec.function.parameters as Record<string, unknown> }
          : {}),
      },
    });
  }
  return out;
}

function validateToolChoice(input: unknown): unknown {
  if (input === undefined) return undefined;
  if (typeof input === 'string') {
    return input === 'auto' || input === 'none' || input === 'required' ? input : undefined;
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const rec = input as { type?: unknown; function?: { name?: unknown } };
    if (
      rec.type === 'function' &&
      rec.function &&
      typeof rec.function.name === 'string' &&
      rec.function.name.trim()
    ) {
      return { type: 'function', function: { name: rec.function.name.trim() } };
    }
  }
  return undefined;
}

export function validateChatMessages(input: unknown): SanitizedChatMessage[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 500) {
    return null;
  }
  const allowedRoles = new Set(['system', 'user', 'assistant', 'tool']);
  const sanitized: SanitizedChatMessage[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') return null;
    const rec = item as {
      role?: unknown;
      content?: unknown;
      tool_calls?: unknown;
      tool_call_id?: unknown;
      name?: unknown;
    };
    if (typeof rec.role !== 'string' || !allowedRoles.has(rec.role)) return null;

    if (rec.role === 'tool') {
      if (typeof rec.content !== 'string') return null;
      if (typeof rec.tool_call_id !== 'string' || !rec.tool_call_id.trim()) return null;
      sanitized.push({
        role: 'tool',
        content: rec.content,
        tool_call_id: rec.tool_call_id,
        ...(typeof rec.name === 'string' && rec.name.trim() ? { name: rec.name.trim() } : {}),
      });
      continue;
    }

    if (rec.role === 'assistant' && rec.tool_calls !== undefined) {
      const toolCalls = validateToolCalls(rec.tool_calls);
      if (!toolCalls) return null;
      if (rec.content !== undefined && rec.content !== null && typeof rec.content !== 'string') {
        return null;
      }
      sanitized.push({
        role: 'assistant',
        content: typeof rec.content === 'string' ? rec.content : null,
        tool_calls: toolCalls,
      });
      continue;
    }

    if (typeof rec.content !== 'string') return null;
    sanitized.push({
      role: rec.role as SanitizedChatMessage['role'],
      content: rec.content,
    });
  }
  return sanitized;
}

function extractModelIds(payload: unknown): string[] {
  const models: string[] = [];
  if (!payload || typeof payload !== 'object') return models;
  const rec = payload as Record<string, unknown>;

  if (Array.isArray(rec.data)) {
    for (const item of rec.data) {
      if (typeof item === 'string') models.push(item);
      else if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
        models.push((item as { id: string }).id);
      }
    }
  } else if (Array.isArray(rec.models)) {
    for (const item of rec.models) {
      if (typeof item === 'string') models.push(item);
      else if (item && typeof item === 'object') {
        const entry = item as { name?: unknown; id?: unknown };
        if (typeof entry.name === 'string') models.push(entry.name);
        else if (typeof entry.id === 'string') models.push(entry.id);
      }
    }
  } else if (Array.isArray(payload)) {
    for (const item of payload) {
      if (typeof item === 'string') models.push(item);
      else if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
        models.push((item as { id: string }).id);
      }
    }
  }
  return models;
}

function parseJsonObjectBody(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
}

function sanitizeUpstreamErrorSnippet(raw: string): string {
  const singleLine = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/"(?:prompt|content|messages|api[_-]?key|password|token)"\s*:\s*"[^"]*"/gi, '"[redacted]"')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return singleLine.length > 120 ? `${singleLine.slice(0, 117)}...` : singleLine;
}

export function createLocalLlmProxyRouter(): Router {
  const router = Router();

  router.use((req: Request, res: Response, next) => {
    const fetchSite = (req.headers['sec-fetch-site'] ?? '').toString().trim().toLowerCase();
    if (fetchSite === 'cross-site') {
      res.status(403).json({
        error: 'LowCon privacy boundary: Cross-site requests to local model proxy are blocked.',
      });
      return;
    }

    const originHeader = req.headers.origin;
    if (typeof originHeader === 'string' && originHeader.trim()) {
      const hostHeader = (req.headers.host ?? '').trim().toLowerCase();
      try {
        const parsedOrigin = new URL(originHeader);
        if (!hostHeader || parsedOrigin.host.toLowerCase() !== hostHeader) {
          res.status(403).json({
            error: 'LowCon privacy boundary: Cross-origin requests to local model proxy are blocked.',
          });
          return;
        }
      } catch {
        res.status(403).json({
          error: 'LowCon privacy boundary: Invalid request Origin header rejected.',
        });
        return;
      }
    }

    const contentType = (req.headers['content-type'] ?? '').toString().trim().toLowerCase();
    if (!contentType.startsWith('application/json')) {
      res.status(415).json({
        error: 'Unsupported Content-Type: expected application/json.',
      });
      return;
    }

    next();
  });

  router.post('/models', async (req: Request, res: Response) => {
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    };
    res.on('close', onClose);

    try {
      const body = parseJsonObjectBody(req.body);
      if (!body) {
        res.status(400).json({ error: 'Invalid request body: expected a JSON object.' });
        return;
      }

      const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
      if (!isLocalLoopbackEndpoint(endpoint)) {
        res.status(403).json({
          error: `LowCon privacy boundary: Remote endpoint '${endpoint}' rejected. Only local loopback addresses (127.0.0.1 / localhost / ::1) are permitted.`,
        });
        return;
      }

      const base = normalizeLocalEndpoint(endpoint);
      recordTrackedLocalEndpoint(base);
      const primaryUrl = `${base}/models`;
      const fallbackUrl = base.endsWith('/v1') ? `${base.slice(0, -3)}/models` : primaryUrl;
      const urls = primaryUrl === fallbackUrl ? [primaryUrl] : [primaryUrl, fallbackUrl];

      let upstreamResp: globalThis.Response | null = null;
      let lastErr = '';

      for (const url of urls) {
        if (controller.signal.aborted) break;
        const attemptController = new AbortController();
        const onParentAbort = () => attemptController.abort();
        controller.signal.addEventListener('abort', onParentAbort, { once: true });
        const timer = setTimeout(() => attemptController.abort(), 5000);
        try {
          const r = await fetch(url, { signal: attemptController.signal, redirect: 'error' });
          if (r.ok) {
            upstreamResp = r;
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

      if (!upstreamResp) {
        if (!res.headersSent && !res.destroyed) {
          res.status(502).json({
            error: `Failed to connect to local server at ${primaryUrl}: ${lastErr}. Is LM Studio's Local Server running?`,
          });
        }
        return;
      }

      let payload: unknown;
      try {
        payload = await upstreamResp.json();
      } catch (err) {
        if (!res.headersSent && !res.destroyed) {
          const msg = err instanceof Error ? err.message : String(err);
          res.status(502).json({ error: `Invalid JSON response from local server at ${primaryUrl}: ${msg}` });
        }
        return;
      }

      if (!res.headersSent && !res.destroyed) {
        res.status(200).json({ endpoint: base, models: extractModelIds(payload) });
      }
    } catch (err) {
      if (!res.headersSent && !res.destroyed) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      res.off('close', onClose);
    }
  });

  router.post('/chat', async (req: Request, res: Response) => {
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    };
    res.on('close', onClose);

    try {
      const body = parseJsonObjectBody(req.body);
      if (!body) {
        res.status(400).json({ error: 'Invalid request body: expected a JSON object.' });
        return;
      }

      const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
      if (!isLocalLoopbackEndpoint(endpoint)) {
        res.status(403).json({
          error: `LowCon privacy boundary: Remote endpoint '${endpoint}' rejected. Only local loopback addresses (127.0.0.1 / localhost / ::1) are permitted.`,
        });
        return;
      }

      const messages = validateChatMessages(body.messages);
      if (!messages) {
        res.status(400).json({ error: 'Invalid chat payload: messages array is required.' });
        return;
      }

      if (body.stream !== undefined && typeof body.stream !== 'boolean') {
        res.status(400).json({ error: 'Invalid chat payload: stream must be a boolean.' });
        return;
      }

      const stream = body.stream !== false;
      const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'local-model';
      const temperature =
        typeof body.temperature === 'number' && Number.isFinite(body.temperature)
          ? Math.min(2, Math.max(0, body.temperature))
          : 0.7;
      const topP =
        typeof body.top_p === 'number' && Number.isFinite(body.top_p)
          ? Math.min(1, Math.max(0.01, body.top_p))
          : 0.9;
      const maxTokens =
        typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens)
          ? Math.min(131072, Math.max(16, Math.floor(body.max_tokens)))
          : 512;
      const stop = Array.isArray(body.stop)
        ? body.stop.filter((s): s is string => typeof s === 'string' && s.length > 0).slice(0, 8)
        : undefined;
      const allowedEfforts = new Set(['low', 'medium', 'high', 'xhigh']);
      const reasoningEffort =
        typeof body.reasoning_effort === 'string' && allowedEfforts.has(body.reasoning_effort)
          ? body.reasoning_effort
          : undefined;
      const tools = validateTools(body.tools);
      if (tools === null) {
        res.status(400).json({ error: 'Invalid chat payload: malformed tools array.' });
        return;
      }
      const toolChoice = tools && tools.length > 0 ? validateToolChoice(body.tool_choice) : undefined;

      const base = normalizeLocalEndpoint(endpoint);
      recordTrackedLocalEndpoint(base, model);
      const url = `${base}/chat/completions`;
      const parsedTarget = new URL(url);
      const transport = parsedTarget.protocol === 'https:' ? https : http;
      const requestBody = JSON.stringify({
        model,
        messages,
        temperature,
        top_p: topP,
        max_tokens: maxTokens,
        stream,
        stop,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
      });

      const upstreamRes = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const onAbort = () => {
          upstreamReq.destroy(new Error('Request aborted'));
        };
        if (controller.signal.aborted) {
          reject(new Error('Request aborted'));
          return;
        }
        const upstreamReq = transport.request(
          parsedTarget,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(requestBody, 'utf8'),
            },
            timeout: 0,
          },
          (incoming) => {
            controller.signal.removeEventListener('abort', onAbort);
            const status = incoming.statusCode ?? 0;
            if (status >= 300 && status < 400) {
              incoming.resume();
              reject(new Error(`Redirect from local server (${status}) rejected.`));
              return;
            }
            resolve(incoming);
          },
        );
        upstreamReq.setTimeout(0);
        upstreamReq.on('error', (err) => {
          controller.signal.removeEventListener('abort', onAbort);
          reject(err);
        });
        controller.signal.addEventListener('abort', onAbort, { once: true });
        upstreamReq.write(requestBody);
        upstreamReq.end();
      });

      const upstreamStatus = upstreamRes.statusCode ?? 502;
      if (upstreamStatus < 200 || upstreamStatus >= 300) {
        const text = await new Promise<string>((resolve) => {
          const chunks: Buffer[] = [];
          upstreamRes.on('data', (c: Buffer) => chunks.push(c));
          upstreamRes.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          upstreamRes.on('error', () => resolve(''));
        });
        const snippet = sanitizeUpstreamErrorSnippet(text);
        if (!res.headersSent && !res.destroyed) {
          res.status(upstreamStatus || 502).json({
            error: `Local server ${url} returned HTTP ${upstreamStatus}${snippet ? `: ${snippet}` : ''}`,
          });
        }
        return;
      }

      const upstreamContentType = String(upstreamRes.headers['content-type'] ?? '').toLowerCase();
      if (!stream || upstreamContentType.includes('application/json')) {
        const text = await new Promise<string>((resolve, reject) => {
          const chunks: Buffer[] = [];
          upstreamRes.on('data', (c: Buffer) => chunks.push(c));
          upstreamRes.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          upstreamRes.on('error', reject);
        });
        let jsonPayload: unknown;
        try {
          jsonPayload = JSON.parse(text);
        } catch {
          if (!res.headersSent && !res.destroyed) {
            res.status(502).json({ error: `Local server ${url} returned invalid JSON.` });
          }
          return;
        }
        if (!res.headersSent && !res.destroyed) {
          res.status(200).json(jsonPayload);
        }
        return;
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      await new Promise<void>((resolve) => {
        const cleanupUpstream = () => {
          if (!upstreamRes.destroyed) {
            upstreamRes.destroy();
          }
          resolve();
        };
        const onAbortStream = () => cleanupUpstream();
        controller.signal.addEventListener('abort', onAbortStream, { once: true });
        upstreamRes.on('data', (chunk: Buffer) => {
          if (res.writableEnded || res.destroyed) {
            cleanupUpstream();
            return;
          }
          if (chunk.byteLength > 0) {
            res.write(chunk);
          }
        });
        upstreamRes.on('end', () => {
          controller.signal.removeEventListener('abort', onAbortStream);
          resolve();
        });
        upstreamRes.on('error', () => {
          controller.signal.removeEventListener('abort', onAbortStream);
          resolve();
        });
      });
      if (!res.writableEnded) {
        res.end();
      }
    } catch (err) {
      if (!res.headersSent) {
        if (!res.destroyed) {
          res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
        }
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      res.off('close', onClose);
    }
  });

  router.post('/unload-all', async (req: Request, res: Response) => {
    try {
      const body = parseJsonObjectBody(req.body);
      if (!body) {
        res.status(400).json({ error: 'Invalid request body: expected a JSON object.' });
        return;
      }

      const rawEndpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
      if (rawEndpoint && !isLocalLoopbackEndpoint(rawEndpoint)) {
        res.status(403).json({
          error: `LowCon privacy boundary: Remote endpoint '${rawEndpoint}' rejected. Only local loopback addresses (127.0.0.1 / localhost / ::1) are permitted.`,
        });
        return;
      }

      const fallbackModels = Array.isArray(body.models)
        ? body.models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0).slice(0, 32)
        : [];

      const result = await unloadAllLocalModels(rawEndpoint || undefined, fallbackModels);
      res.status(200).json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
