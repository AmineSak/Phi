// /api/lsp: a WebSocket per tab, each with its own texlab in the open project's folder.
// The socket is closed (and texlab stopped) when the tab goes away or another project opens.

import type { LspStatusResponse } from '@phi/shared';
import type { Server, ServerWebSocket } from 'bun';

import {
  findTexlab,
  routeClientMessage,
  routeServerMessage,
  startLanguageServer,
  type LanguageServer,
} from '../services/lsp.ts';
import { isAllowed } from './security.ts';

export interface LspSocketData {
  root: string;
  server?: LanguageServer;
}

/** Close code telling the browser not to reconnect to this project (it was switched). */
export const PROJECT_CLOSED = 4000;

export function lspHandlers({
  port,
  root,
  find = findTexlab,
}: {
  port: number;
  /** The open project's root, or null. */
  root: () => string | null;
  find?: typeof findTexlab;
}) {
  const sockets = new Set<ServerWebSocket<LspSocketData>>();

  return {
    async status(): Promise<Response> {
      const texlab = find();
      let version: string | null = null;
      if (texlab) {
        const proc = Bun.spawn([texlab.binary, '--version'], { stdout: 'pipe', stderr: 'ignore' });
        version = (await new Response(proc.stdout).text()).trim() || null;
      }
      return Response.json({ available: !!texlab, version } satisfies LspStatusResponse);
    },

    /** Upgrades GET /api/lsp after the same origin checks as every /api route. */
    upgrade(req: Request, server: Server<LspSocketData>): Response | undefined {
      if (!isAllowed(req, port))
        return Response.json({ error: 'Forbidden origin' }, { status: 403 });
      const open = root();
      if (!open) return Response.json({ error: 'No project is open' }, { status: 409 });
      if (!find()) return Response.json({ error: 'texlab is not installed' }, { status: 503 });
      if (server.upgrade(req, { data: { root: open } })) return undefined;
      return Response.json({ error: 'Expected a WebSocket' }, { status: 400 });
    },

    websocket: {
      open(ws: ServerWebSocket<LspSocketData>) {
        const texlab = find();
        if (!texlab) {
          ws.close(1011, 'texlab is not installed');
          return;
        }
        sockets.add(ws);
        const lsp = startLanguageServer(
          [texlab.binary],
          ws.data.root,
          (json) => {
            const route = routeServerMessage(json);
            if (!route) return;
            if ('reply' in route) lsp.send(route.reply);
            else ws.send(route.forward);
          },
          texlab.path,
        );
        ws.data.server = lsp;
        void lsp.exited.then(() => {
          if (sockets.has(ws)) ws.close(1011, 'texlab stopped');
        });
      },
      message(ws: ServerWebSocket<LspSocketData>, message: string | Buffer) {
        const route = routeClientMessage(String(message), ws.data.root);
        if (!route) return;
        if ('reply' in route) ws.send(route.reply);
        else ws.data.server?.send(route.forward);
      },
      close(ws: ServerWebSocket<LspSocketData>) {
        sockets.delete(ws);
        ws.data.server?.kill();
      },
    },

    /** Another project was opened: every socket of the old one closes. */
    closeAll(): void {
      for (const ws of sockets) {
        sockets.delete(ws);
        ws.data.server?.kill();
        ws.close(PROJECT_CLOSED, 'Project closed');
      }
    },
  };
}
