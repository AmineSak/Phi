// texlab, the LaTeX language server, behind a filter. The browser speaks LSP over a WebSocket;
// this module frames messages for texlab's stdio and decides what may pass in each direction.
// Only completion and document sync reach texlab: nothing that builds, formats or runs commands.

import { relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findTexBinary, TEX_BIN_DIRS } from './latex.ts';
import { resolveInProject } from './paths.ts';

/** Where Homebrew puts texlab; a server started from the Dock has neither on PATH. */
const TEXLAB_DIRS = [...TEX_BIN_DIRS, '/opt/homebrew/bin', '/usr/local/bin'];

export function findTexlab(
  path: string = process.env.PATH ?? '',
  fallbacks: readonly string[] = TEXLAB_DIRS,
): { binary: string; path: string } | null {
  return findTexBinary('texlab', path, fallbacks);
}

// ---- Framing (LSP base protocol: "Content-Length: n\r\n\r\n" + n bytes of JSON) -------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function frame(json: string): Uint8Array {
  const body = encoder.encode(json);
  const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const out = new Uint8Array(header.length + body.length);
  out.set(header);
  out.set(body, header.length);
  return out;
}

const HEADER_END = encoder.encode('\r\n\r\n');

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Feeds stdout chunks in; calls `onMessage` with each complete JSON body, however split. */
export function createFrameReader(onMessage: (json: string) => void): (chunk: Uint8Array) => void {
  let buffer: Uint8Array = new Uint8Array(0);
  return (chunk) => {
    const joined = new Uint8Array(buffer.length + chunk.length);
    joined.set(buffer);
    joined.set(chunk, buffer.length);
    buffer = joined;
    for (;;) {
      const end = indexOf(buffer, HEADER_END);
      if (end < 0) return;
      const header = decoder.decode(buffer.subarray(0, end));
      const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1]);
      const start = end + HEADER_END.length;
      if (!Number.isFinite(length)) {
        buffer = buffer.slice(start); // a header without a length: skip it
        continue;
      }
      if (buffer.length < start + length) return;
      const body = decoder.decode(buffer.subarray(start, start + length));
      buffer = buffer.slice(start + length);
      onMessage(body);
    }
  };
}

// ---- Filtering ------------------------------------------------------------------------

/** Where a message goes: on to its destination, back to its sender, or nowhere. */
export type Route = { forward: string } | { reply: string } | null;

interface Message {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/** What the browser may ask of texlab. Everything else is refused. */
const CLIENT_METHODS = new Set([
  'initialize',
  'initialized',
  'shutdown',
  'exit',
  '$/cancelRequest',
  'textDocument/didOpen',
  'textDocument/didChange',
  'textDocument/didClose',
  'textDocument/didSave',
  'textDocument/completion',
  'completionItem/resolve',
]);

/** texlab's settings: no builds, no chktex, no formatters, no forward search. */
export const TEXLAB_SETTINGS = {
  build: { onSave: false, forwardSearchAfter: false },
  chktex: { onOpenAndSave: false, onEdit: false },
  latexFormatter: 'none',
  bibtexFormatter: 'none',
  forwardSearch: {},
};

function parse(raw: string): Message | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Message) : null;
  } catch {
    return null;
  }
}

const errorReply = (id: Message['id'], message: string) =>
  JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message } });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** True when a document URI names a file inside the project (and not its app data). */
export function isProjectUri(uri: unknown, root: string): boolean {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return false;
  try {
    resolveInProject(root, relative(root, fileURLToPath(uri)));
    return true;
  } catch {
    return false;
  }
}

/**
 * A message from the browser: forwarded when it is allowed, refused with an error reply when it
 * is a request that isn't, dropped otherwise. `initialize` is rewritten to the project's root.
 */
export function routeClientMessage(raw: string, root: string): Route {
  const message = parse(raw);
  if (!message || typeof message.method !== 'string') return null;
  const isRequest = message.id !== undefined && message.id !== null;
  const refuse = (why: string): Route =>
    isRequest ? { reply: errorReply(message.id, why) } : null;

  if (!CLIENT_METHODS.has(message.method)) return refuse(`${message.method} is not available`);
  if (message.method === 'initialize') {
    const params = isRecord(message.params) ? message.params : {};
    const capabilities = isRecord(params.capabilities) ? params.capabilities : {};
    const workspace = isRecord(capabilities.workspace) ? capabilities.workspace : {};
    const rootUri = pathToFileURL(root).href;
    return {
      forward: JSON.stringify({
        ...message,
        params: {
          ...params,
          processId: null,
          rootUri,
          rootPath: root,
          workspaceFolders: [{ uri: rootUri, name: 'project' }],
          // texlab asks for its settings; the proxy answers (see routeServerMessage).
          capabilities: { ...capabilities, workspace: { ...workspace, configuration: true } },
          initializationOptions: TEXLAB_SETTINGS,
        },
      }),
    };
  }
  const params = isRecord(message.params) ? message.params : {};
  const document = isRecord(params.textDocument) ? params.textDocument : null;
  if (document && !isProjectUri(document.uri, root))
    return refuse('Document is outside the project');
  return { forward: raw };
}

/**
 * A message from texlab: settings requests are answered here, diagnostics are dropped (compile
 * errors come from the build log), everything else goes to the browser.
 */
export function routeServerMessage(raw: string): Route {
  const message = parse(raw);
  if (!message) return null;
  if (message.method === 'workspace/configuration') {
    const items =
      isRecord(message.params) && Array.isArray(message.params.items) ? message.params.items : [];
    return {
      reply: JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: items.map(() => TEXLAB_SETTINGS),
      }),
    };
  }
  if (message.method === 'textDocument/publishDiagnostics') return null;
  return { forward: raw };
}

// ---- Process --------------------------------------------------------------------------

export interface LanguageServer {
  /** Sends one JSON message to the server. */
  send(json: string): void;
  kill(): void;
  exited: Promise<number>;
}

/** Starts `command` in `root`, speaking LSP over stdio; `onMessage` gets each JSON body. */
export function startLanguageServer(
  command: string[],
  root: string,
  onMessage: (json: string) => void,
  path: string = process.env.PATH ?? '',
): LanguageServer {
  const proc = Bun.spawn(command, {
    cwd: root,
    env: { ...process.env, PATH: path },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const read = createFrameReader(onMessage);
  void (async () => {
    for await (const chunk of proc.stdout) read(chunk);
  })();
  return {
    send(json) {
      if (proc.exitCode !== null || proc.killed) return;
      proc.stdin.write(frame(json));
      void proc.stdin.flush();
    },
    kill() {
      if (proc.exitCode === null && !proc.killed) proc.kill();
    },
    exited: proc.exited,
  };
}
