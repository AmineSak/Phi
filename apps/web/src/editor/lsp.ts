// LaTeX completion from texlab, through the server's /api/lsp WebSocket. No React here.
// The editor swaps one EditorState per file into a single view, so the LSP plugin is
// recreated on every switch; the workspace below keeps each file open on the server across
// those switches and reads documents from views.ts, including files not on screen.
// Without texlab (not installed, or the socket is down), completion falls back to completions.ts.

import { autocompletion } from '@codemirror/autocomplete';
import {
  LSPClient,
  LSPPlugin,
  serverCompletion,
  Workspace,
  type Transport,
  type WorkspaceFile,
} from '@codemirror/lsp-client';
import { ChangeSet, Compartment, type Extension, type Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { api } from '../api/client.ts';
import { useProjectStore } from '../store/project-store.ts';
import { latexCompletions } from './completions.ts';

/** Holds each file state's completion setup; reconfigured when texlab comes and goes. */
export const lspCompartment = new Compartment();

/** Close code the server uses when another project was opened: don't reconnect. */
const PROJECT_CLOSED = 4000;
const MAX_RETRIES = 5;

/** LSP language of a project file, or null when completion doesn't apply. */
export function languageOf(path: string): 'latex' | 'bibtex' | null {
  if (/\.(tex|sty|cls|ltx|dtx)$/i.test(path)) return 'latex';
  if (/\.bib$/i.test(path)) return 'bibtex';
  return null;
}

/** file:// URI of `path` (project-relative) under absolute `root`, or of `root` itself. */
export function fileUri(root: string, path = ''): string {
  const absolute = path ? `${root.replace(/\/+$/, '')}/${path}` : root;
  return `file://${absolute.split('/').map(encodeURIComponent).join('/')}`;
}

/** The smallest single change turning `a` into `b`. */
export function diffDocs(a: Text, b: Text): ChangeSet {
  const x = a.toString();
  const y = b.toString();
  const max = Math.min(x.length, y.length);
  let start = 0;
  while (start < max && x.charCodeAt(start) === y.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && x.charCodeAt(x.length - 1 - end) === y.charCodeAt(y.length - 1 - end))
    end++;
  return ChangeSet.of(
    { from: start, to: x.length - end, insert: y.slice(start, y.length - end) },
    x.length,
  );
}

let docSource: (path: string) => Text | undefined = () => undefined;

/** Where the workspace reads a file's current document (views.ts provides it). */
export function setDocSource(source: (path: string) => Text | undefined): void {
  docSource = source;
}

class ProjectFile implements WorkspaceFile {
  constructor(
    readonly uri: string,
    readonly path: string,
    readonly languageId: string,
    public version: number,
    public doc: Text,
    public view: EditorView | null,
  ) {}

  getView(): EditorView | null {
    return this.view;
  }
}

/** Files stay open on the server from first shown until closed, renamed or deleted. */
export class ProjectWorkspace extends Workspace {
  files: ProjectFile[] = [];

  constructor(
    client: LSPClient,
    private readonly root: string,
    /** A file's current document, on screen or not. */
    private readonly docOf: (path: string) => Text | undefined,
  ) {
    super(client);
  }

  private pathOf(uri: string): string {
    return decodeURIComponent(uri.slice(fileUri(this.root).length + 1));
  }

  syncFiles() {
    const updates = [];
    for (const file of this.files) {
      const doc = this.docOf(file.path);
      if (doc && !doc.eq(file.doc)) {
        updates.push({ file, prevDoc: file.doc, changes: diffDocs(file.doc, doc) });
        file.doc = doc;
        file.version++;
      }
      // The plugin maps server positions from what it believes the server has: now `doc`.
      const plugin = file.view && LSPPlugin.get(file.view);
      if (plugin && plugin.uri === file.uri) plugin.clear();
    }
    return updates;
  }

  openFile(uri: string, languageId: string, view: EditorView): void {
    const open = this.files.find((f) => f.uri === uri);
    if (open) {
      open.view = view;
      return;
    }
    const path = this.pathOf(uri);
    const file = new ProjectFile(
      uri,
      path,
      languageId,
      0,
      this.docOf(path) ?? view.state.doc,
      view,
    );
    this.files.push(file);
    this.client.didOpen(file);
  }

  /** The view moved to another file: this one stays open on the server. */
  closeFile(uri: string, view: EditorView): void {
    const file = this.files.find((f) => f.uri === uri);
    if (file?.view === view) file.view = null;
  }

  /** The file is gone from the editor (closed, renamed, deleted). */
  forget(path: string): void {
    const file = this.files.find((f) => f.path === path);
    if (!file) return;
    this.files = this.files.filter((f) => f !== file);
    this.client.didClose(file.uri);
  }

  override connected(): void {
    // Files open once the client is initialized and the editor states get the plugin.
  }
}

function socketTransport(ws: WebSocket): Transport {
  const handlers = new Set<(value: string) => void>();
  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') for (const handler of handlers) handler(event.data);
  });
  return {
    // lsp-client sends notifications from promise callbacks, where a throw would go unhandled.
    // Once the socket is closing, its close handler swaps completion back to the fallback.
    send(message) {
      if (ws.readyState === WebSocket.OPEN) ws.send(message);
    },
    subscribe: (handler) => void handlers.add(handler),
    unsubscribe: (handler) => void handlers.delete(handler),
  };
}

interface Session {
  root: string;
  stopped: boolean;
  ws: WebSocket | null;
  /** Set once texlab answered `initialize`; null while connecting or down. */
  client: LSPClient | null;
  workspace: ProjectWorkspace | null;
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
}

let session: Session | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Called when completion switches between texlab and the fallback (views.ts reconfigures). */
export function onLspChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function connect(s: Session): void {
  const ws = new WebSocket(
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/lsp`,
  );
  s.ws = ws;
  ws.addEventListener('open', () => {
    const client = new LSPClient({
      rootUri: fileUri(s.root),
      workspace: (c) => new ProjectWorkspace(c, s.root, docSource),
      extensions: [serverCompletion({ override: true })],
      timeout: 5000,
    });
    client.connect(socketTransport(ws));
    client.initializing.then(
      () => {
        if (s.ws !== ws || s.stopped) return;
        s.client = client;
        s.workspace = client.workspace as ProjectWorkspace;
        s.failures = 0;
        notify();
      },
      () => ws.close(),
    );
  });
  ws.addEventListener('close', (event) => {
    if (s.ws !== ws) return;
    s.ws = null;
    if (s.client) {
      s.client.disconnect();
      s.client = null;
      s.workspace = null;
      notify();
    }
    if (s.stopped || event.code === PROJECT_CLOSED || ++s.failures > MAX_RETRIES) return;
    s.timer = setTimeout(() => connect(s), Math.min(1000 * 2 ** (s.failures - 1), 15_000));
  });
}

/** Starts completion for the project at `root`: texlab when the server has it. */
export async function startLsp(root: string): Promise<void> {
  if (session?.root === root && !session.stopped) return;
  stopLsp();
  const s: Session = {
    root,
    stopped: false,
    ws: null,
    client: null,
    workspace: null,
    failures: 0,
    timer: null,
  };
  session = s;
  const status = await api.lspStatus().catch(() => ({ available: false, version: null }));
  if (s.stopped) return;
  useProjectStore.setState({ completion: status });
  if (status.available) connect(s);
}

/** Stops completion for the current project (another one is opening). */
export function stopLsp(): void {
  const s = session;
  if (!s) return;
  session = null;
  s.stopped = true;
  if (s.timer) clearTimeout(s.timer);
  s.ws?.close();
  s.client?.disconnect();
  if (s.client) notify();
}

/** The completion setup of a file state: texlab's plugin when connected, else the fallback. */
export function lspExtension(path: string): Extension {
  const language = languageOf(path);
  if (!language) return [];
  if (session?.client) return session.client.plugin(fileUri(session.root, path), language);
  return language === 'latex' ? autocompletion({ override: [latexCompletions] }) : [];
}

/** A file left the editor (closed, deleted, or renamed away from `path`). */
export function lspForget(path: string): void {
  session?.workspace?.forget(path);
}
