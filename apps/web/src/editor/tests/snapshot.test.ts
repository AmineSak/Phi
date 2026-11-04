import { expect, test } from 'bun:test';

import { MAX_SELECTION_CHARS, MAX_SNAPSHOT_DIRTY_BYTES } from '@phi/shared';

import { fitSnapshot } from '../snapshot.ts';

const file = (path: string, size = 10) => ({ path, content: 'x'.repeat(size) });

test('no file open: nulls and empty lists', () => {
  expect(fitSnapshot({ activeFile: null, cursor: null, dirty: [] })).toEqual({
    activeFile: null,
    cursorLine: null,
    dirtyFiles: [],
    revertedToolCallIds: [],
  });
});

test('cursor and selection; the selection text is cut to 2000 characters', () => {
  const snapshot = fitSnapshot({
    activeFile: 'main.tex',
    cursor: { line: 7, selection: { from: 5, to: 7, text: 'y'.repeat(MAX_SELECTION_CHARS + 1) } },
    dirty: [],
  });
  expect(snapshot.cursorLine).toBe(7);
  expect(snapshot.selection).toMatchObject({ from: 5, to: 7 });
  expect(snapshot.selection?.text).toHaveLength(MAX_SELECTION_CHARS);
});

test('at most 5 dirty files, the active one first', () => {
  const dirty = ['a', 'b', 'c', 'd', 'e', 'f', 'main'].map((n) => file(`${n}.tex`));
  const { dirtyFiles } = fitSnapshot({ activeFile: 'main.tex', cursor: { line: 1 }, dirty });
  expect(dirtyFiles.map((f) => f.path)).toEqual(['main.tex', 'a.tex', 'b.tex', 'c.tex', 'd.tex']);
});

test('at most 200 KB in total: a buffer that does not fit is skipped, smaller ones still go', () => {
  const half = MAX_SNAPSHOT_DIRTY_BYTES / 2;
  const { dirtyFiles } = fitSnapshot({
    activeFile: 'main.tex',
    cursor: { line: 1 },
    dirty: [file('big.tex', half + 1), file('main.tex', half), file('small.tex', 100)],
  });
  expect(dirtyFiles.map((f) => f.path)).toEqual(['main.tex', 'small.tex']);
});

test('multi-byte text counts in UTF-8 bytes', () => {
  const content = 'é'.repeat(MAX_SNAPSHOT_DIRTY_BYTES / 2); // 2 bytes each: exactly the limit
  const fits = fitSnapshot({ activeFile: null, cursor: null, dirty: [{ path: 'a.tex', content }] });
  expect(fits.dirtyFiles).toHaveLength(1);
  const over = fitSnapshot({
    activeFile: null,
    cursor: null,
    dirty: [{ path: 'a.tex', content: `${content}é` }],
  });
  expect(over.dirtyFiles).toHaveLength(0);
});
