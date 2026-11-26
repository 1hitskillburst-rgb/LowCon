import { Router, type Request, type Response } from 'express';

const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

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

interface SanitizedChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function validateChatMessages(input: unknown): SanitizedChatMessage[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 500) {
    return null;
  }
  const allowedRoles = new Set(['system', 'user', 'assistant']);
  const sanitized: SanitizedChatMessage[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') return null;
    const rec = item as { role?: unknown; content?: unknown };
    if (typeof rec.role !== 'string' || !allowedRoles.has(rec.role)) return null;
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
      if (item && typeof item === 'object') {
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

export function createLocalLlmProxyRouter(): Router {
  const router = Router();

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
          const r = await fetch(url, { signal: attemptController.signal });
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

      const base = normalizeLocalEndpoint(endpoint);
      const url = `${base}/chat/completions`;

      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          top_p: topP,
          max_tokens: maxTokens,
          stream,
          stop,
        }),
        signal: controller.signal,
      });

      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => '');
        if (!res.headersSent && !res.destroyed) {
          res.status(upstream.status || 502).json({
            error: `Local server ${url} returned HTTP ${upstream.status}: ${text.slice(0, 200)}`,
          });
        }
        return;
      }

      const upstreamContentType = (upstream.headers.get('content-type') ?? '').toLowerCase();
      if (!stream || upstreamContentType.includes('application/json')) {
        const text = await upstream.text();
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

  return router;
}
