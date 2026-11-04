import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createFrameReader,
  findTexlab,
  frame,
  isProjectUri,
  routeClientMessage,
  routeServerMessage,
  startLanguageServer,
  TEXLAB_SETTINGS,
  type LanguageServer,
} from '../lsp.ts';

let root: string;
let server: LanguageServer | null = null;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lsp-test-')));
});

afterEach(() => {
  server?.kill();
  server = null;
  rmSync(root, { recursive: true, force: true });
});

const uri = (path: string) => pathToFileURL(join(root, path)).href;
/** A JSON-RPC message; a null id makes it a notification. */
const message = (method: string, params: unknown = {}, id: number | null = 1) =>
  JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params });
const forwarded = (route: ReturnType<typeof routeClientMessage>) =>
  route && 'forward' in route ? JSON.parse(route.forward) : null;
const replied = (route: ReturnType<typeof routeClientMessage>) =>
  route && 'reply' in route ? JSON.parse(route.reply) : null;

describe('framing', () => {
  const read = (chunks: Uint8Array[]) => {
    const out: string[] = [];
    const feed = createFrameReader((json) => out.push(json));
    for (const chunk of chunks) feed(chunk);
    return out;
  };

  test('one message, split anywhere, comes out whole', () => {
    const bytes = frame('{"id":1,"label":"\\\\section"}');
    for (let cut = 0; cut <= bytes.length; cut++) {
      expect(read([bytes.slice(0, cut), bytes.slice(cut)])).toEqual([
        '{"id":1,"label":"\\\\section"}',
      ]);
    }
  });

  test('several messages in one chunk, and byte lengths with multi-byte text', () => {
    const a = '{"text":"é∑ — 𝔸"}';
    const b = '{"n":2}';
    const both = new Uint8Array([...frame(a), ...frame(b)]);
    expect(read([both])).toEqual([a, b]);
    // One byte at a time: a multi-byte character split across chunks still decodes.
    expect(read([...both].map((byte) => new Uint8Array([byte])))).toEqual([a, b]);
  });

  test('extra headers are fine; a header without a length is skipped', () => {
    const encoder = new TextEncoder();
    const odd = encoder.encode(
      'Content-Type: x\r\n\r\nContent-Type: y\r\nContent-Length: 2\r\n\r\n{}',
    );
    expect(read([odd])).toEqual(['{}']);
  });
});

describe('what the browser may send', () => {
  test('initialize is pinned to the project root and its settings', () => {
    const route = routeClientMessage(
      message('initialize', {
        rootUri: 'file:///etc',
        rootPath: '/etc',
        workspaceFolders: [{ uri: 'file:///', name: 'all' }],
        capabilities: { workspace: { applyEdit: true } },
      }),
      root,
    );
    const params = forwarded(route).params;
    expect(params.rootUri).toBe(pathToFileURL(root).href);
    expect(params.rootPath).toBe(root);
    expect(params.workspaceFolders).toEqual([{ uri: pathToFileURL(root).href, name: 'project' }]);
    expect(params.capabilities.workspace).toEqual({ applyEdit: true, configuration: true });
    expect(params.initializationOptions).toEqual(TEXLAB_SETTINGS);
  });

  test('document sync and completion for project files pass unchanged', () => {
    for (const raw of [
      message('textDocument/didOpen', { textDocument: { uri: uri('main.tex'), text: '' } }, null),
      message('textDocument/didChange', { textDocument: { uri: uri('ch/a.tex') } }, null),
      message('textDocument/completion', { textDocument: { uri: uri('main.tex') } }),
      message('completionItem/resolve', { label: 'x' }),
      message('$/cancelRequest', { id: 3 }, null),
      message('shutdown', null),
    ]) {
      expect(routeClientMessage(raw, root)).toEqual({ forward: raw });
    }
  });

  test('anything that builds, formats or runs commands is refused with an error reply', () => {
    for (const method of [
      'workspace/executeCommand',
      'textDocument/build',
      'textDocument/forwardSearch',
      'textDocument/formatting',
      'textDocument/rename',
      'workspace/didChangeConfiguration',
    ]) {
      const reply = replied(routeClientMessage(message(method, {}, 7), root));
      expect(reply.id).toBe(7);
      expect(reply.error.message).toContain(method);
    }
    // A refused notification is just dropped (there is no one to answer).
    expect(routeClientMessage(message('textDocument/build', {}, null), root)).toBeNull();
  });

  test('documents outside the project, or in its app data, are refused', () => {
    mkdirSync(join(root, 'link'));
    const outside = mkdtempSync(join(tmpdir(), 'lsp-outside-'));
    symlinkSync(outside, join(root, 'escape'));
    try {
      for (const bad of [
        'file:///etc/passwd',
        pathToFileURL(join(root, '..', 'x.tex')).href,
        uri('.latex-agent/threads.json'),
        uri('escape/secret.tex'),
        'http://127.0.0.1/main.tex',
        42,
      ]) {
        expect(isProjectUri(bad, root)).toBe(false);
        const route = routeClientMessage(
          message('textDocument/completion', { textDocument: { uri: bad } }),
          root,
        );
        expect(replied(route).error.message).toBe('Document is outside the project');
      }
      expect(isProjectUri(uri('link/new file #1.tex'), root)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('garbage and batches are dropped', () => {
    expect(routeClientMessage('not json', root)).toBeNull();
    expect(routeClientMessage('[{"method":"initialize"}]', root)).toBeNull();
    expect(routeClientMessage('{"id":1}', root)).toBeNull();
  });
});

describe('what texlab may send', () => {
  test('settings requests are answered by the proxy, one settings object per item', () => {
    const route = routeServerMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'workspace/configuration',
        params: { items: [{}, {}] },
      }),
    );
    expect(route && 'reply' in route && JSON.parse(route.reply)).toEqual({
      jsonrpc: '2.0',
      id: 9,
      result: [TEXLAB_SETTINGS, TEXLAB_SETTINGS],
    });
  });

  test('diagnostics are dropped; responses and other messages go to the browser', () => {
    expect(
      routeServerMessage(JSON.stringify({ method: 'textDocument/publishDiagnostics', params: {} })),
    ).toBeNull();
    const response = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { items: [] } });
    expect(routeServerMessage(response)).toEqual({ forward: response });
  });
});

describe('startLanguageServer', () => {
  const FAKE = join(import.meta.dir, '__fixtures__/fake-lsp.ts');

  test('frames requests over stdio and reads framed replies', async () => {
    const replies: string[] = [];
    server = startLanguageServer([process.execPath, FAKE], root, (json) => replies.push(json));
    server.send(message('textDocument/completion', { text: 'é' }, 4));
    while (replies.length === 0) await Bun.sleep(10);
    expect(JSON.parse(replies[0] as string)).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: { method: 'textDocument/completion', params: { text: 'é' } },
    });
    server.kill();
    expect(await server.exited).not.toBe(0);
    server.send(message('shutdown')); // after exit: ignored, no throw
  });
});

describe.skipIf(!findTexlab())('real texlab', () => {
  test('completes labels from other files, bib keys and environment names', async () => {
    mkdirSync(join(root, 'chapters'));
    const main = [
      '\\documentclass{article}',
      '\\begin{document}',
      '\\input{chapters/a}',
      'See \\ref{}.',
      '\\cite{}',
      '\\begin{ite}',
      '\\bibliography{refs}',
      '\\end{document}',
      '',
    ].join('\n');
    writeFileSync(join(root, 'main.tex'), main);
    writeFileSync(join(root, 'chapters/a.tex'), '\\section{A}\\label{sec:alpha}\n');
    writeFileSync(join(root, 'refs.bib'), '@article{knuth84, title={Literate}, year={1984}}\n');

    const texlab = findTexlab()!;
    const pending = new Map<number, (result: unknown) => void>();
    const lsp = startLanguageServer(
      [texlab.binary],
      root,
      (json) => {
        const route = routeServerMessage(json);
        if (!route) return;
        if ('reply' in route) return lsp.send(route.reply);
        const msg = JSON.parse(route.forward) as { id?: number; method?: string; result?: unknown };
        if (msg.method && msg.id !== undefined) {
          lsp.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }));
        } else if (typeof msg.id === 'number') pending.get(msg.id)?.(msg.result);
      },
      texlab.path,
    );
    server = lsp;
    let id = 0;
    const send = (method: string, params: unknown, request = true) => {
      const route = routeClientMessage(message(method, params, request ? ++id : null), root);
      if (!route || !('forward' in route)) throw new Error(`refused: ${method}`);
      lsp.send(route.forward);
      const mine = id;
      return request ? new Promise((resolve) => pending.set(mine, resolve)) : Promise.resolve();
    };
    const labels = async (line: number, character: number) => {
      const result = (await send('textDocument/completion', {
        textDocument: { uri: uri('main.tex') },
        position: { line, character },
      })) as { items?: { label: string }[] } | { label: string }[];
      return (Array.isArray(result) ? result : (result.items ?? [])).map((i) => i.label);
    };

    await send('initialize', { capabilities: {} });
    await send('initialized', {}, false);
    await send(
      'textDocument/didOpen',
      { textDocument: { uri: uri('main.tex'), languageId: 'latex', version: 0, text: main } },
      false,
    );
    // texlab indexes the project in the background; retry until it has.
    let refs: string[] = [];
    for (let i = 0; i < 50 && !refs.includes('sec:alpha'); i++) {
      refs = await labels(3, 9);
      if (!refs.includes('sec:alpha')) await Bun.sleep(100);
    }
    expect(refs).toContain('sec:alpha');
    expect(await labels(4, 6)).toContain('knuth84');
    expect((await labels(5, 10))[0]).toBe('itemize');
  }, 20_000);
});
