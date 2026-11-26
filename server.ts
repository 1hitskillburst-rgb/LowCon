import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalLlmProxyRouter, unloadAllLocalModels } from './server/localLlmProxy.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const IS_PROD = process.env.NODE_ENV === 'production';

export function createApiApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', app: 'LowCon' });
  });

  app.use('/api/local-llm', createLocalLlmProxyRouter());

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API route not found.' });
  });

  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const bodyErr = err as { type?: string; status?: number; statusCode?: number; message?: string } | null;
    if (bodyErr?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Malformed JSON request body.' });
      return;
    }
    if (bodyErr?.type === 'entity.too.large' || bodyErr?.status === 413 || bodyErr?.statusCode === 413) {
      res.status(413).json({ error: 'Request body exceeds the 2MB limit.' });
      return;
    }
    if (req.path.startsWith('/api/')) {
      const status = typeof bodyErr?.status === 'number' ? bodyErr.status : 500;
      res.status(status).json({ error: bodyErr?.message || 'Internal server error.' });
      return;
    }
    next(err);
  });

  return app;
}

async function startServer() {
  const app = createApiApp();

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    const indexHtml = path.join(distDir, 'index.html');
    if (!fs.existsSync(indexHtml)) {
      throw new Error(`Production build not found at ${distDir}. Run "npm run build" first.`);
    }
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api/')) {
        res.sendFile(indexHtml);
        return;
      }
      next();
    });
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(`LowCon listening on http://${HOST}:${PORT} (${IS_PROD ? 'production' : 'dev'})`);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const timeout = new Promise((resolve) => setTimeout(resolve, 2000));
    Promise.race([unloadAllLocalModels().catch(() => {}), timeout]).finally(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function isDirectEntry(): boolean {
  if (!process.argv[1]) return false;
  const entry = path.resolve(process.argv[1]);
  const self = fileURLToPath(import.meta.url);
  return process.platform === 'win32'
    ? entry.toLowerCase() === self.toLowerCase()
    : entry === self;
}

if (isDirectEntry()) {
  startServer().catch((err) => {
    console.error('Failed to start LowCon server:', err);
    process.exit(1);
  });
}
