import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Server } from 'bun';

import { IapError } from '../../services/iap.ts';
import { TEXLAB_SETTINGS } from '../../services/lsp.ts';
import { lspHandlers, PROJECT_CLOSED, type LspSocketData } from '../lsp.ts';

const FAKE = join(import.meta.dir, '../../services/tests/__fixtures__/fake-lsp.ts');

let root: string | null;
let bin: string;
let handlers: ReturnType<typeof lspHandlers>;
let server: Server<LspSocketData>;
let sockets: WebSocket[];

/** An executable "texlab" that runs the fake language server. */
function fakeTexlab(): { binary: string; path: string } {
  const binary = join(bin, 'texlab');
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}"\n`);
  chmodSync(binary, 0o755);
  return { binary, path: process.env.PATH ?? '' };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lsp-route-')));
  bin = realpathSync(mkdtempSync(join(tmpdir(), 'lsp-bin-')));
  const texlab = fakeTexlab();
  sockets = [];
  let late: ReturnType<typeof lspHandlers> | null = null;
  server = Bun.serve<LspSocketData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req, srv) => late!.upgrade(req, srv),
    websocket: {
      open: (ws) => late!.websocket.open(ws),
      message: (ws, msg) => late!.websocket.message(ws, msg),
      close: (ws) => late!.websocket.close(ws),
    },
  });
  handlers = lspHandlers({ access: server.port!, root: () => root, find: () => texlab });
  late = handlers;
});

afterEach(async () => {
  for (const ws of sockets) ws.close();
  await server.stop(true);
  for (const dir of [root, bin]) if (dir) rmSync(dir, { recursive: true, force: true });
});

const origin = () => `http://127.0.0.1:${server.port}`;

/** Opens a socket like the browser does; resolves once it is open. */
async function connect(headers: Record<string, string> = { origin: origin() }) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/lsp`, { headers });
  sockets.push(ws);
  const messages: { id?: number | string; result?: unknown; error?: { message: string } }[] = [];
  ws.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data))));
  const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', resolve));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('socket error')));
  });
  const reply = async (id: number) => {
    for (let i = 0; i < 300; i++) {
      const found = messages.find((m) => m.id === id);
      if (found) return found;
      await Bun.sleep(10);
    }
    throw new Error(`no reply to ${id}`);
  };
  const send = (method: string, params: unknown, id?: number) =>
    ws.send(
      JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }),
    );
  return { ws, messages, closed, reply, send };
}

/** What the fake language server received, in order. */
const received = (): {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
}[] =>
  existsSync(join(root!, 'received.jsonl'))
    ? readFileSync(join(root!, 'received.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];

const pidOf = async () => {
  for (let i = 0; i < 300 && !existsSync(join(root!, 'fake-lsp.pid')); i++) await Bun.sleep(10);
  return Number(readFileSync(join(root!, 'fake-lsp.pid'), 'utf8'));
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('upgrade', () => {
  const req = (headers: Record<string, string>) =>
    new Request(`http://127.0.0.1:${server.port}/api/lsp`, { headers });
  const noUpgrade = { upgrade: () => false } as unknown as Server<LspSocketData>;

  test('a foreign Origin or Host is refused before upgrading (403)', async () => {
    for (const headers of [{ origin: 'https://evil.example' }, { origin: 'http://127.0.0.1:1' }]) {
      const res = (await handlers.upgrade(req(headers), noUpgrade))!;
      expect(res.status).toBe(403);
    }
    const rebinding = new Request(`http://evil.example:${server.port}/api/lsp`);
    expect((await handlers.upgrade(rebinding, noUpgrade))!.status).toBe(403);
    // Over a real socket the handshake fails too.
    await expect(connect({ origin: 'https://evil.example' })).rejects.toThrow();
  });

  test('deployed, the upgrade needs the IAP token like every /api route (SPEC 9.1)', async () => {
    const deployed = lspHandlers({
      access: {
        port: server.port!,
        iap: async (token) => {
          if (token !== 'good') throw new IapError(401, 'Sign in through IAP');
          return 'me@example.com';
        },
      },
      root: () => root,
      find: () => fakeTexlab(),
    });
    expect((await deployed.upgrade(req({ origin: origin() }), noUpgrade))!.status).toBe(401);
    const signedIn = new Request(`http://127.0.0.1:${server.port}/api/lsp`, {
      headers: { origin: origin(), 'x-goog-iap-jwt-assertion': 'good' },
    });
    // Past the checks: noUpgrade can't upgrade, so this is the "not a WebSocket" answer.
    expect((await deployed.upgrade(signedIn, noUpgrade))!.status).toBe(400);
  });

  test('409 without a project, 503 without texlab, 400 when not a WebSocket', async () => {
    expect((await handlers.upgrade(req({ origin: origin() }), noUpgrade))!.status).toBe(400);
    const saved = root;
    root = null;
    expect((await handlers.upgrade(req({}), noUpgrade))!.status).toBe(409);
    root = saved;
    const none = lspHandlers({ access: server.port!, root: () => root, find: () => null });
    expect((await none.upgrade(req({}), noUpgrade))!.status).toBe(503);
  });
});

describe('status', () => {
  test('reports whether texlab is installed, and its version', async () => {
    const versioned = join(bin, 'texlab-v');
    writeFileSync(versioned, '#!/bin/sh\necho "texlab 9.9.9"\n');
    chmodSync(versioned, 0o755);
    const found = lspHandlers({
      access: 1,
      root: () => root,
      find: () => ({ binary: versioned, path: '' }),
    });
    expect(await (await found.status()).json()).toEqual({
      available: true,
      version: 'texlab 9.9.9',
    });
    const missing = lspHandlers({ access: 1, root: () => root, find: () => null });
    expect(await (await missing.status()).json()).toEqual({ available: false, version: null });
  });
});

describe('socket', () => {
  test('relays allowed messages; refuses the rest without reaching the server', async () => {
    const { send, reply, messages } = await connect();
    send('initialize', { rootUri: 'file:///', capabilities: {} }, 1);
    const init = (await reply(1)).result as { received: { rootUri: string } };
    expect(init.received.rootUri).toBe(pathToFileURL(root!).href);

    const uri = pathToFileURL(join(root!, 'main.tex')).href;
    send('textDocument/didOpen', {
      textDocument: { uri, languageId: 'latex', version: 0, text: '' },
    });
    send('workspace/executeCommand', { command: 'texlab.cleanArtifacts' }, 2);
    send('textDocument/build', { textDocument: { uri } }, 3);
    send('textDocument/completion', { textDocument: { uri: 'file:///etc/passwd' } }, 4);
    send(
      'textDocument/completion',
      { textDocument: { uri }, position: { line: 0, character: 0 } },
      5,
    );

    expect((await reply(2)).error!.message).toContain('workspace/executeCommand');
    expect((await reply(3)).error!.message).toContain('textDocument/build');
    expect((await reply(4)).error!.message).toBe('Document is outside the project');
    expect((await reply(5)).result).toMatchObject({ method: 'textDocument/completion' });

    // The proxy answered texlab's settings request; diagnostics never reached the browser.
    for (let i = 0; i < 300 && !received().some((m) => m.id === 'settings'); i++)
      await Bun.sleep(10);
    expect(received().find((m) => m.id === 'settings')?.result).toEqual([TEXLAB_SETTINGS]);
    expect(received().flatMap((m) => (m.method ? [m.method] : []))).toEqual([
      'initialize',
      'textDocument/didOpen',
      'textDocument/completion',
    ]);
    expect(messages.some((m) => 'method' in m)).toBe(false);
  });

  test('closing the socket stops the language server', async () => {
    const { ws } = await connect();
    const pid = await pidOf();
    expect(alive(pid)).toBe(true);
    ws.close();
    for (let i = 0; i < 300 && alive(pid); i++) await Bun.sleep(10);
    expect(alive(pid)).toBe(false);
  });

  test('opening another project closes every socket with PROJECT_CLOSED and stops its server', async () => {
    const { closed } = await connect();
    const pid = await pidOf();
    handlers.closeAll();
    expect((await closed).code).toBe(PROJECT_CLOSED);
    for (let i = 0; i < 300 && alive(pid); i++) await Bun.sleep(10);
    expect(alive(pid)).toBe(false);
  });

  test('a language server that exits closes the socket', async () => {
    const { closed } = await connect();
    process.kill(await pidOf());
    expect((await closed).code).toBe(1011);
  });
});
