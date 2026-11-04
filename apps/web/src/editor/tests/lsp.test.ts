import { expect, test } from 'bun:test';
import { LSPClient } from '@codemirror/lsp-client';
import { Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { diffDocs, fileUri, languageOf, ProjectWorkspace } from '../lsp.ts';

test('file URIs encode each path segment', () => {
  expect(fileUri('/Users/me/thesis')).toBe('file:///Users/me/thesis');
  expect(fileUri('/Users/me/thesis/', 'chapters/intro.tex')).toBe(
    'file:///Users/me/thesis/chapters/intro.tex',
  );
  expect(fileUri('/Users/me/my thesis', 'a#1 é.tex')).toBe(
    'file:///Users/me/my%20thesis/a%231%20%C3%A9.tex',
  );
});

test('languages: LaTeX sources and BibTeX; nothing for other files', () => {
  expect(['main.tex', 'x.sty', 'x.cls', 'A.TEX'].map(languageOf)).toEqual([
    'latex',
    'latex',
    'latex',
    'latex',
  ]);
  expect(languageOf('refs.bib')).toBe('bibtex');
  expect(languageOf('notes.md')).toBeNull();
  expect(languageOf('figure.png')).toBeNull();
});

test('diffDocs gives one change that turns a into b', () => {
  const cases: [string, string][] = [
    ['hello world', 'hello brave world'],
    ['abc', ''],
    ['', 'abc'],
    ['aaaa', 'aa'],
    ['line 1\nline 2\n', 'line 1\nline two\n'],
    ['same', 'same'],
  ];
  for (const [a, b] of cases) {
    const changes = diffDocs(Text.of(a.split('\n')), Text.of(b.split('\n')));
    expect(changes.apply(Text.of(a.split('\n'))).toString()).toBe(b);
    let count = 0;
    changes.iterChanges(() => count++);
    expect(count).toBeLessThanOrEqual(1);
  }
});

/** A client connected to a recording fake server that supports incremental sync. */
async function recordingWorkspace(docs: Map<string, Text>) {
  const sent: { method: string; params: { textDocument: { uri: string; version?: number } } }[] =
    [];
  const client = new LSPClient({
    rootUri: fileUri('/p'),
    workspace: (c) => new ProjectWorkspace(c, '/p', (path) => docs.get(path)),
  });
  let receive: (message: string) => void = () => {};
  client.connect({
    send: (message) => {
      const { id, method, params } = JSON.parse(message);
      if (method === 'initialize') {
        const result = { capabilities: { textDocumentSync: 2 } };
        queueMicrotask(() => receive(JSON.stringify({ jsonrpc: '2.0', id, result })));
      }
      if (method?.startsWith('textDocument/')) sent.push({ method, params });
    },
    subscribe: (handler) => (receive = handler),
    unsubscribe: () => {},
  });
  await client.initializing;
  return { client, workspace: client.workspace as ProjectWorkspace, sent };
}

/** Stands in for the editor: shows some other file (no LSP plugin of these). */
const fakeView = { state: { doc: Text.of(['']) }, plugin: () => null } as unknown as EditorView;
/** Notifications go out once initialize resolved: after a microtask. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('files stay open on the server while the view shows other files', async () => {
  const docs = new Map([
    ['main.tex', Text.of(['\\section{A}'])],
    ['ch/b c.tex', Text.of(['b'])],
  ]);
  const { workspace, sent } = await recordingWorkspace(docs);
  const mainUri = fileUri('/p', 'main.tex');
  const otherUri = fileUri('/p', 'ch/b c.tex');

  workspace.openFile(mainUri, 'latex', fakeView);
  workspace.closeFile(mainUri, fakeView); // the view swapped to another file
  workspace.openFile(otherUri, 'latex', fakeView);
  workspace.openFile(mainUri, 'latex', fakeView); // and back
  await flush();
  expect(sent.map((m) => `${m.method} ${m.params.textDocument.uri}`)).toEqual([
    `textDocument/didOpen ${mainUri}`,
    `textDocument/didOpen ${otherUri}`,
  ]);
  expect(workspace.files.map((f) => f.uri)).toEqual([mainUri, otherUri]);
});

test('syncFiles sends what changed in any open file, on or off screen', async () => {
  const docs = new Map([
    ['main.tex', Text.of(['\\section{A}'])],
    ['b.tex', Text.of(['b'])],
  ]);
  const { client, workspace, sent } = await recordingWorkspace(docs);
  workspace.openFile(fileUri('/p', 'main.tex'), 'latex', fakeView);
  workspace.openFile(fileUri('/p', 'b.tex'), 'latex', fakeView);
  await flush();
  sent.length = 0;

  docs.set('b.tex', Text.of(['b edited off screen']));
  client.sync();
  await flush();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    method: 'textDocument/didChange',
    params: { textDocument: { uri: fileUri('/p', 'b.tex'), version: 1 } },
  });
  expect(workspace.getFile(fileUri('/p', 'b.tex'))?.doc.toString()).toBe('b edited off screen');

  client.sync(); // nothing new
  await flush();
  expect(sent).toHaveLength(1);
});

test('forget closes the file on the server once', async () => {
  const docs = new Map([['main.tex', Text.of(['x'])]]);
  const { workspace, sent } = await recordingWorkspace(docs);
  workspace.openFile(fileUri('/p', 'main.tex'), 'latex', fakeView);
  workspace.forget('main.tex');
  workspace.forget('main.tex');
  await flush();
  expect(sent.map((m) => m.method)).toEqual(['textDocument/didOpen', 'textDocument/didClose']);
  expect(workspace.files).toEqual([]);
});
