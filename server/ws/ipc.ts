import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, WebSocket } from 'ws';
import { WS_HEARTBEAT_INTERVAL_MS } from '../../src/config/constants.ts';
import type { ShowRunnerMode } from '../../src/config/runtime.ts';
import { getStageRow } from '../fsm/gates.ts';
import { isOriginAllowed } from '../security/origin.ts';
import { verifyBearerTokenConstantTime } from '../security/token.ts';
import type { Stage6PromptsPayload } from '../stages/s6Prompts.ts';

export interface IpcBroadcaster {
  broadcast: (event: { type: string; payload: unknown }) => void;
  getClientCount: () => number;
  close: () => void;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  type?: string;
}

export function attachIpcWebSocketServer(params: {
  httpServer: HttpServer;
  db: DatabaseSync;
  mode: ShowRunnerMode;
  expectedToken: string;
  requireBearerAuth: boolean;
}): IpcBroadcaster {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  params.httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    const rawUrl = request.url || '';
    const parsedUrl = new URL(rawUrl, 'http://127.0.0.1');
    if (parsedUrl.pathname !== '/ws/ipc') {
      return;
    }

    const origin = request.headers.origin;
    if (!isOriginAllowed(origin, params.mode)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    if (params.requireBearerAuth) {
      const queryToken = parsedUrl.searchParams.get('token') || '';
      const authHeader = request.headers.authorization || '';
      const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
      const providedToken = (bearerMatch ? bearerMatch[1] : queryToken).trim();

      if (!providedToken || !verifyBearerTokenConstantTime(providedToken, params.expectedToken)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);

    ws.send(
      JSON.stringify({
        type: 'IPC_CONNECTED',
        payload: {
          protocol: 'JSON-RPC 2.0',
          heartbeatIntervalMs: WS_HEARTBEAT_INTERVAL_MS,
          timestamp: new Date().toISOString(),
        },
      })
    );

    ws.on('message', (data) => {
      let msg: JsonRpcRequest;
      try {
        msg = JSON.parse(data.toString('utf8')) as JsonRpcRequest;
      } catch {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          })
        );
        return;
      }

      if (msg.type === 'PING' || msg.method === 'ping') {
        ws.send(
          JSON.stringify({
            type: 'PONG',
            jsonrpc: '2.0',
            id: msg.id ?? null,
            result: { pong: true, timestamp: Date.now() },
          })
        );
        return;
      }

      const rpcId = msg.id ?? null;
      const method = msg.method ?? '';
      const rpcParams = msg.params ?? {};

      const resolveProjectId = (): string | null => {
        if (typeof rpcParams.projectId === 'string' && rpcParams.projectId.trim()) {
          return rpcParams.projectId.trim();
        }
        const row = params.db
          .prepare(`SELECT id FROM projects ORDER BY updated_at DESC LIMIT 1`)
          .get() as { id: string } | undefined;
        return row?.id ?? null;
      };

      if (method === 'queue.offer' || method === 'queue.get' || method === 'pushPack') {
        const projectId = resolveProjectId();
        if (!projectId) {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: rpcId,
              error: { code: -32001, message: 'No active project found.' },
            })
          );
          return;
        }

        const s6Row = getStageRow(params.db, projectId, 'S6');
        if (!s6Row || s6Row.status !== 'PASSED') {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: rpcId,
              error: {
                code: -32002,
                message: 'Stage 6 visual prompts are not yet assembled for this project.',
              },
            })
          );
          return;
        }

        const s6Payload = JSON.parse(s6Row.payload_json) as Stage6PromptsPayload;
        const requestedPackIdx =
          typeof rpcParams.packIndex === 'number' ? rpcParams.packIndex : null;
        const selectedPack =
          requestedPackIdx !== null
            ? s6Payload.packs.find((p) => p.packIndex === requestedPackIdx) ?? s6Payload.packs[0]
            : null;

        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpcId,
            result: {
              projectId,
              mode: s6Payload.mode,
              totalPrompts: s6Payload.totalPrompts,
              totalBatches: s6Payload.totalBatches,
              batches: s6Payload.batches,
              packCount: s6Payload.packCount,
              packs: selectedPack ? [selectedPack] : s6Payload.packs,
              prompts: s6Payload.prompts,
            },
          })
        );
        return;
      }

      if (method === 'progress' || method === 'done') {
        const broadcastEvent = {
          type: method === 'done' ? 'DOWNSTREAM_RENDER_DONE' : 'DOWNSTREAM_RENDER_PROGRESS',
          payload: rpcParams,
        };
        for (const client of clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(broadcastEvent));
          }
        }
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpcId,
            result: { acknowledged: true },
          })
        );
        return;
      }

      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpcId,
          error: { code: -32601, message: `Method not found: ${method}` },
        })
      );
    });

    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  // 10s heartbeat to keep MV3 extension service workers alive
  const heartbeatTimer = setInterval(() => {
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.ping();
          client.send(
            JSON.stringify({
              type: 'PING',
              timestamp: Date.now(),
            })
          );
        } catch {
          clients.delete(client);
        }
      }
    }
  }, WS_HEARTBEAT_INTERVAL_MS);

  heartbeatTimer.unref?.();

  return {
    broadcast: (event) => {
      const serialized = JSON.stringify(event);
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(serialized);
        }
      }
    },
    getClientCount: () => clients.size,
    close: () => {
      clearInterval(heartbeatTimer);
      for (const client of clients) {
        client.close();
      }
      wss.close();
    },
  };
}
