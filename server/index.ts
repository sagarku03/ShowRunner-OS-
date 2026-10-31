import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import {
  HEAP_GC_THRESHOLD_BYTES,
  HEAP_CHECK_INTERVAL_MS,
} from '../src/config/constants.ts';
import { resolveRuntimeConfig } from '../src/config/runtime.ts';
import { createShowRunnerApp } from './app.ts';
import { openDatabase } from './db/db.ts';
import { getOrCreateMachineSecret } from './security/machineKey.ts';
import { getOrCreateBearerToken } from './security/token.ts';
import { attachIpcWebSocketServer } from './ws/ipc.ts';

export async function startServer(): Promise<http.Server> {
  const runtime = resolveRuntimeConfig();

  getOrCreateMachineSecret();
  const expectedToken = getOrCreateBearerToken();
  const db = openDatabase();

  let broadcasterRef: { broadcast: (ev: { type: string; payload: unknown }) => void } | null =
    null;

  const app = createShowRunnerApp({
    db,
    runtime,
    expectedToken,
    onBroadcast: (ev) => broadcasterRef?.broadcast(ev),
  });

  const httpServer = http.createServer(app);
  const ipc = attachIpcWebSocketServer({
    httpServer,
    db,
    mode: runtime.mode,
    expectedToken,
    requireBearerAuth: runtime.requireBearerAuth,
  });
  broadcasterRef = ipc;

  const isProd = process.env.NODE_ENV === 'production';
  const distPath = path.resolve(process.cwd(), 'dist');

  if (!isProd && runtime.mode === 'preview') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        watch: null,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.use((req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/ws/')) {
        next();
        return;
      }
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  if (runtime.mode === 'termux') {
    const gcTimer = setInterval(() => {
      const used = process.memoryUsage().heapUsed;
      if (used > HEAP_GC_THRESHOLD_BYTES && typeof global.gc === 'function') {
        global.gc();
      }
    }, HEAP_CHECK_INTERVAL_MS);
    gcTimer.unref?.();
  }

  await new Promise<void>((resolve) => {
    httpServer.listen(runtime.port, runtime.host, () => {
      console.log(
        `[ShowRunner OS v1.3.0] Listening on http://${runtime.host}:${runtime.port} (mode=${runtime.mode}, auth=${runtime.requireBearerAuth ? 'BEARER_REQUIRED' : 'PREVIEW'})`
      );
      resolve();
    });
  });

  return httpServer;
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('server/index.ts') ||
    process.argv[1].endsWith('server.ts') ||
    process.argv[1].endsWith('server.mjs'));

if (isMain) {
  startServer().catch((err) => {
    console.error('[ShowRunner OS Fatal Startup Error]', err);
    process.exit(1);
  });
}
