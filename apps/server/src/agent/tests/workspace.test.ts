import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EditorSnapshot } from '@phi/shared';

import { createReadFileTool } from '../tools/read-file.ts';
import { createSearchTool } from '../tools/search.ts';
import { createWorkspace } from '../workspace.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workspace-test-'));
  mkdirSync(join(root, 'chapters'));
  writeFileSync(join(root, 'main.tex'), 'line one\nline two\nline three on disk\n');
  writeFileSync(join(root, 'chapters', 'intro.tex'), 'Saved intro.\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const snapshot = (dirtyFiles: EditorSnapshot['dirtyFiles']): EditorSnapshot => ({
  activeFile: 'main.tex',
  cursorLine: 3,
  dirtyFiles,
  revertedToolCallIds: [],
});

const textOf = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map((c) => c.text ?? '').join('');

test('readText returns the disk content until a snapshot has a dirty buffer', async () => {
  const workspace = createWorkspace(root);
  expect(await workspace.readText('main.tex')).toBe('line one\nline two\nline three on disk\n');

  workspace.setSnapshot(snapshot([{ path: 'main.tex', content: 'line one\nline two\nUNSAVED\n' }]));
  expect(await workspace.readText('main.tex')).toBe('line one\nline two\nUNSAVED\n');
  // Same file, different spelling.
  expect(await workspace.readText('./main.tex')).toBe('line one\nline two\nUNSAVED\n');
  // Files without a buffer still come from disk.
  expect(await workspace.readText('chapters/intro.tex')).toBe('Saved intro.\n');

  // The latest snapshot wins: once saved, the buffer is gone and the disk is read again.
  workspace.setSnapshot(snapshot([]));
  expect(await workspace.readText('main.tex')).toBe('line one\nline two\nline three on disk\n');
});

test('setSnapshot rejects paths outside the project and keeps the previous snapshot', () => {
  const workspace = createWorkspace(root);
  const good = snapshot([]);
  workspace.setSnapshot(good);
  expect(() =>
    workspace.setSnapshot(snapshot([{ path: '../outside.tex', content: 'x' }])),
  ).toThrow();
  expect(() => workspace.setSnapshot({ ...good, activeFile: '/etc/passwd' })).toThrow();
  expect(() =>
    workspace.setSnapshot(snapshot([{ path: '.latex-agent/settings.json', content: '{}' }])),
  ).toThrow();
  expect(workspace.snapshot).toBe(good);
});

test('read_file and search see unsaved edits', async () => {
  const workspace = createWorkspace(root);
  workspace.setSnapshot(
    snapshot([{ path: 'main.tex', content: 'line one\nline two\nThe unsaved third line\n' }]),
  );

  const read = await createReadFileTool(root, workspace).execute('id', {
    path: 'main.tex',
    offset: 3,
    limit: 1,
  });
  expect(textOf(read)).toBe('The unsaved third line');
  expect(read.details).toMatchObject({ totalLines: 3, truncated: false });

  const search = createSearchTool(root, workspace);
  expect(textOf(await search.execute('id', { query: 'unsaved third' }))).toBe(
    'main.tex:3: The unsaved third line',
  );
  expect(textOf(await search.execute('id', { query: 'on disk' }))).toBe(
    'No matches for "on disk".',
  );
});
