// Completion in the real editor (views.ts + lsp.ts in happy-dom), against a fake texlab behind a
// fake WebSocket: typing \ref{ asks the server, the item shows, Enter inserts it. Also the
// fallback when texlab is missing or the socket drops, and files staying open across switches.
/// <reference types="bun" />
// First: the DOM must exist before CodeMirror loads.
import { registerDom, unregisterDom } from '../../tests/dom.ts';

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { completionStatus, currentCompletions } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';

import { useProjectStore } from '../../store/project-store.ts';
import { startLsp, stopLsp } from '../lsp.ts';
import { closeAll, getDoc, mountEditor, openFile } from '../views.ts';

const ROOT = '/Users/me/my thesis';
const files = new Map<string, string>();
let texlabInstalled = true;

function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input), 'http://127.0.0.1:3000');
  const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));
  if (url.pathname === '/api/lsp/status') {
    return json({ available: texlabInstalled, version: texlabInstalled ? 'texlab 5.26.0' : null });
  }
  const file = url.pathname.match(/^\/api\/files\/(.+)$/)?.[1];
  const content = file && files.get(decodeURIComponent(file));
  if (file && content !== undefined) return json({ path: file, content, mtimeMs: 1 });
  return json({ error: `unexpected ${url.pathname}` }, 404);
}

interface Received {
  id?: number;
  method: string;
  params: {
    textDocument: { uri: string; text?: string };
    contentChanges?: { text: string }[];
    position?: { line: number; character: number };
  };
}

type Listener = (event: { data?: string; code?: number }) => void;

/**
 * A WebSocket to a fake texlab that knows one label and records what it was sent. It keeps its
 * own listeners: EventTarget and Event may come from Bun or happy-dom depending on test order.
 */
class FakeSocket {
  static readonly OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  received: Received[] = [];
  /** The text of each open document, as the server knows it. */
  docs = new Map<string, string>();
  private listeners: { type: string; listener: Listener }[] = [];

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.emit('open', {});
    }, 0);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.push({ type, listener });
  }

  private emit(type: string, event: { data?: string; code?: number }): void {
    for (const l of this.listeners) if (l.type === type) l.listener(event);
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as Received;
    this.received.push(message);
    const uri = message.params?.textDocument?.uri;
    if (message.method === 'textDocument/didOpen')
      this.docs.set(uri, message.params.textDocument.text!);
    if (message.method === 'textDocument/didChange') {
      // Small documents are always sent whole.
      this.docs.set(uri, message.params.contentChanges!.at(-1)!.text);
    }
    if (message.method === 'initialize') {
      this.reply(message.id!, {
        capabilities: {
          textDocumentSync: 2,
          completionProvider: { triggerCharacters: ['\\', '{'] },
        },
      });
    }
    if (message.method === 'textDocument/completion') {
      const { line, character } = message.params.position!;
      const text = (this.docs.get(uri) ?? '').split('\n')[line]!.slice(0, character);
      const typed = /\\ref\{([^}]*)$/.exec(text);
      const items = typed
        ? [
            {
              label: 'sec:alpha',
              kind: 18,
              textEdit: {
                newText: 'sec:alpha',
                range: {
                  start: { line, character: character - typed[1]!.length },
                  end: { line, character },
                },
              },
            },
          ]
        : [];
      this.reply(message.id!, items);
    }
  }

  private reply(id: number, result: unknown): void {
    setTimeout(() => {
      if (this.readyState === 1) {
        this.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id, result }) });
      }
    }, 0);
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { code });
  }
}

let host: HTMLElement;
let unmount: () => void;
const realWebSocket = globalThis.WebSocket;
const realFetch = globalThis.fetch;

async function until(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const view = () => EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!;
const socket = () => FakeSocket.all.at(-1)!;
const labels = () => currentCompletions(view().state).map((c) => c.label);
const methods = (s = socket()) => s.received.map((m) => m.method);

/** Types at the end of the document, one key per transaction. */
function typeAtEnd(text: string): void {
  for (const ch of text) {
    const end = view().state.doc.length;
    view().dispatch({
      changes: { from: end, insert: ch },
      selection: { anchor: end + 1 },
      userEvent: 'input.type',
    });
  }
}

function press(key: string): void {
  view().contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
}

beforeAll(() => {
  registerDom();
  globalThis.fetch = fakeFetch as typeof fetch;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  host = document.createElement('div');
  document.body.append(host);
  unmount = mountEditor(host);
});

afterEach(() => {
  stopLsp();
  closeAll();
  FakeSocket.all = [];
  texlabInstalled = true;
});

afterAll(async () => {
  globalThis.WebSocket = realWebSocket;
  globalThis.fetch = realFetch;
  unmount?.();
  await unregisterDom();
});

test('typing \\ref{ shows the label from texlab; Enter inserts it', async () => {
  files.set('main.tex', 'See ');
  await openFile('main.tex');
  await startLsp(ROOT);
  await until(() => methods().includes('textDocument/didOpen'), 'the file to open on the server');

  const uri = 'file:///Users/me/my%20thesis/main.tex';
  expect(socket().url).toBe('ws://127.0.0.1:3000/api/lsp');
  expect(socket().received[0]).toMatchObject({
    method: 'initialize',
    params: { rootUri: 'file:///Users/me/my%20thesis' },
  });
  expect(socket().docs.get(uri)).toBe('See ');
  expect(useProjectStore.getState().completion).toEqual({
    available: true,
    version: 'texlab 5.26.0',
  });

  typeAtEnd('\\ref{');
  await until(() => labels().includes('sec:alpha'), 'the completion from texlab');
  // The server had the typed text before it was asked.
  expect(socket().docs.get(uri)).toBe('See \\ref{');
  // The popup ignores keys for its first 75 ms (interactionDelay), to ignore stray presses.
  await new Promise((r) => setTimeout(r, 100));
  press('Enter');
  expect(getDoc('main.tex')).toBe('See \\ref{sec:alpha');
  expect(completionStatus(view().state)).toBeNull();
});

test('switching files keeps both open on the server: no close, no second open', async () => {
  files.set('main.tex', 'main');
  files.set('chapters/a.tex', 'chapter');
  await startLsp(ROOT);
  await until(() => FakeSocket.all.length === 1 && methods().includes('initialized'), 'initialize');
  await openFile('main.tex');
  await openFile('chapters/a.tex');
  await openFile('main.tex');
  await until(() => socket().docs.size === 2, 'both files to open');
  typeAtEnd('!');
  await openFile('chapters/a.tex');
  typeAtEnd('\\ref{');
  await until(() => labels().includes('sec:alpha'), 'completion in the second file');
  expect(methods().filter((m) => m === 'textDocument/didOpen')).toHaveLength(2);
  expect(methods()).not.toContain('textDocument/didClose');
  // The edit made in main.tex before switching away reached the server too.
  expect(socket().docs.get('file:///Users/me/my%20thesis/main.tex')).toBe('main!');
});

test('a dropped socket falls back to basic completion, then reconnects to texlab', async () => {
  files.set('main.tex', '');
  await openFile('main.tex');
  await startLsp(ROOT);
  await until(() => methods().includes('textDocument/didOpen'), 'texlab to be ready');

  socket().close(1011);
  typeAtEnd('\\begin{ite');
  await until(() => labels().includes('itemize'), 'the fallback environments');
  expect(FakeSocket.all).toHaveLength(1);

  await until(() => FakeSocket.all.length === 2, 'a reconnect', 3000);
  await until(
    () => methods().includes('textDocument/didOpen'),
    'the file to reopen on the new server',
  );
  expect(socket().docs.get('file:///Users/me/my%20thesis/main.tex')).toBe('\\begin{ite');
});

test('without texlab: no socket, basic completion, and the store says so', async () => {
  texlabInstalled = false;
  files.set('main.tex', 'x\\label{eq:one}\n');
  await openFile('main.tex');
  await startLsp(ROOT);
  expect(FakeSocket.all).toHaveLength(0);
  expect(useProjectStore.getState().completion).toEqual({ available: false, version: null });
  typeAtEnd('\\eqref{');
  await until(() => labels().includes('eq:one'), 'labels of the open file');
});

test('another project: the socket closes for good, and \\begin pairs still close', async () => {
  files.set('main.tex', '');
  await openFile('main.tex');
  await startLsp(ROOT);
  await until(() => methods().includes('textDocument/didOpen'), 'texlab to be ready');
  const first = socket();
  stopLsp();
  expect(first.readyState).toBe(3);
  await new Promise((r) => setTimeout(r, 1200));
  expect(FakeSocket.all).toHaveLength(1);

  typeAtEnd('\\begin{itemize}');
  expect(getDoc('main.tex')).toBe('\\begin{itemize}\n  \n\\end{itemize}');
});
