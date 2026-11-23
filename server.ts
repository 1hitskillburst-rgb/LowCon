import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalLlmProxyRouter } from './server/localLlmProxy.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const IS_PROD = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', app: 'LowCon' });
  });

  app.use('/api/local-llm', createLocalLlmProxyRouter());

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

  app.listen(PORT, HOST, () => {
    console.log(`LowCon listening on http://${HOST}:${PORT} (${IS_PROD ? 'production' : 'dev'})`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start LowCon server:', err);
  process.exit(1);
});
