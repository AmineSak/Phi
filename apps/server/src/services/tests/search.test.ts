import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_MATCHES, searchProject } from '../search.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'search-test-'));
  mkdirSync(join(root, 'chapters'));
  writeFileSync(
    join(root, 'main.tex'),
    '\\section{Intro}\n\\label{sec:intro}\nSee \\ref{sec:intro}.\n',
  );
  writeFileSync(join(root, 'chapters', 'a.tex'), 'An INTRO paragraph.\n');
  writeFileSync(join(root, 'refs.bib'), '@book{knuth1984,\n  title = {The TeXbook}\n}\n');
  writeFileSync(join(root, 'notes.txt'), 'intro in a txt file is not searched\n');
  writeFileSync(join(root, 'main.log'), 'intro in a log is not searched\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test('plain queries match case-insensitively in .tex/.bib/.sty/.cls only', async () => {
  expect(await searchProject(root, 'intro')).toEqual({
    matches: [
      { path: 'chapters/a.tex', line: 1, text: 'An INTRO paragraph.' },
      { path: 'main.tex', line: 1, text: '\\section{Intro}' },
      { path: 'main.tex', line: 2, text: '\\label{sec:intro}' },
      { path: 'main.tex', line: 3, text: 'See \\ref{sec:intro}.' },
    ],
    limited: false,
  });
});

test('plain queries treat regex characters literally', async () => {
  expect((await searchProject(root, '\\ref{')).matches).toHaveLength(1);
});

test('regex queries', async () => {
  const { matches } = await searchProject(root, '^@\\w+\\{', true);
  expect(matches).toEqual([{ path: 'refs.bib', line: 1, text: '@book{knuth1984,' }]);
});

test('an invalid regex throws', async () => {
  await expect(searchProject(root, '(unclosed', true)).rejects.toThrow('Invalid regex');
});

test('an empty query throws', async () => {
  await expect(searchProject(root, '')).rejects.toThrow('empty');
});

test('stops at 100 matches and trims long lines to 200 chars', async () => {
  const long = `  hit ${'x'.repeat(300)}  `;
  writeFileSync(join(root, 'big.tex'), Array.from({ length: 150 }, () => long).join('\n'));
  const { matches, limited } = await searchProject(root, 'hit');
  expect(limited).toBe(true);
  expect(matches).toHaveLength(MAX_MATCHES);
  expect(matches[0]?.text).toBe(`${`hit ${'x'.repeat(300)}`.slice(0, 200)}…`);
});

test('no matches is an empty result, not an error', async () => {
  expect(await searchProject(root, 'nothing-like-this')).toEqual({ matches: [], limited: false });
});

test('an aborted signal stops the search', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await expect(searchProject(root, 'intro', false, controller.signal)).rejects.toThrow('stop');
});
