import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

function isLocalLoopbackEndpoint(rawEndpoint: string): boolean {
  try {
    const trimmed = rawEndpoint.trim();
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    const parsed = new URL(withProto);
    const host = parsed.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

function normalizeEndpoint(rawEndpoint: string): string {
  let trimmed = rawEndpoint.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `http://${trimmed}`;
  }
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function localLoopbackProxyPlugin(): Plugin {
  return {
    name: 'lowcon-local-loopback-proxy',
    configureServer(server) {
      server.middlewares.use('/api/local-llm/models', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const endpoint = String(body.endpoint ?? '');
          if (!isLocalLoopbackEndpoint(endpoint)) {
            sendJson(res, 403, {
              error: `LowCon privacy boundary: Remote endpoint '${endpoint}' rejected. Only local loopback addresses (127.0.0.1 / localhost / ::1) are permitted.`,
            });
            return;
          }

          const base = normalizeEndpoint(endpoint);
          const primaryUrl = `${base}/models`;
          const fallbackUrl = base.endsWith('/v1') ? `${base.slice(0, -3)}/models` : primaryUrl;

          let upstreamResp: Response | null = null;
          let lastErr = '';
          for (const url of primaryUrl === fallbackUrl ? [primaryUrl] : [primaryUrl, fallbackUrl]) {
            try {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 5000);
              const r = await fetch(url, { signal: controller.signal });
              clearTimeout(timer);
              if (r.ok) {
                upstreamResp = r;
                break;
              }
              lastErr = `HTTP ${r.status} from ${url}`;
            } catch (err) {
              lastErr = err instanceof Error ? err.message : String(err);
            }
          }

          if (!upstreamResp) {
            sendJson(res, 502, {
              error: `Failed to connect to local server at ${primaryUrl}: ${lastErr}. Is LM Studio's Local Server running?`,
            });
            return;
          }

          const payload = (await upstreamResp.json()) as Record<string, unknown>;
          const models: string[] = [];
          if (Array.isArray(payload.data)) {
            for (const item of payload.data) {
              if (typeof item === 'string') models.push(item);
              else if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
                models.push((item as { id: string }).id);
              }
            }
          } else if (Array.isArray(payload.models)) {
            for (const item of payload.models) {
              if (item && typeof item === 'object') {
                const rec = item as { name?: unknown; id?: unknown };
                if (typeof rec.name === 'string') models.push(rec.name);
                else if (typeof rec.id === 'string') models.push(rec.id);
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
          sendJson(res, 200, { endpoint: base, models });
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      });

      server.middlewares.use('/api/local-llm/chat', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const endpoint = String(body.endpoint ?? '');
          if (!isLocalLoopbackEndpoint(endpoint)) {
            sendJson(res, 403, {
              error: `LowCon privacy boundary: Remote endpoint '${endpoint}' rejected. Only local loopback addresses are permitted.`,
            });
            return;
          }

          const base = normalizeEndpoint(endpoint);
          const url = `${base}/chat/completions`;
          const controller = new AbortController();
          req.on('close', () => controller.abort());

          const upstream = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: body.model,
              messages: body.messages,
              temperature: body.temperature ?? 0.7,
              top_p: body.top_p ?? 0.9,
              max_tokens: body.max_tokens ?? 512,
              stream: true,
              stop: body.stop ?? undefined,
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
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), localLoopbackProxyPlugin()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
    hmr: false,
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
  },
});
