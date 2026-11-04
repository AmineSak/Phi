import { expect, test } from 'bun:test';

import { diffHunk, type HunkChange } from '../proposal.ts';

/** Applies changes (in old-text offsets) to `text`. */
function apply(text: string, changes: HunkChange[]): string {
  let out = '';
  let cursor = 0;
  for (const c of changes) {
    out += text.slice(cursor, c.from) + c.insert;
    cursor = c.to;
  }
  return out + text.slice(cursor);
}

test('within a line: only the changed words, never half a word', () => {
  const changes = diffHunk('Hello from the sample project.', 'Welcome to the sample project.');
  expect(changes).toEqual([{ from: 0, to: 10, insert: 'Welcome to' }]);
  expect(diffHunk('Hello world', 'Hallo world')).toEqual([{ from: 0, to: 5, insert: 'Hallo' }]);
  // A LaTeX command counts as part of the word.
  expect(diffHunk('see \\ref{a} now', 'see \\cref{a} now')).toEqual([
    { from: 4, to: 8, insert: '\\cref' },
  ]);
});

test('across lines: unchanged lines are left alone; a changed line is delete + insert', () => {
  const old = 'one\ntwo\nthree\nfour\n';
  const next = 'one\nTWO\nthree\nfour\nfive\n';
  const changes = diffHunk(old, next);
  expect(changes).toEqual([
    { from: 4, to: 8, insert: 'TWO\n' },
    { from: 19, to: 19, insert: 'five\n' },
  ]);
  expect(apply(old, changes)).toBe(next);
});

test("the user's real proposal: only the figure and the new section are marked", () => {
  const old = [
    '\\section{Introduction}',
    "Hello from the sample project. Euler's identity: $e^{i\\pi} + 1 = 0$.",
    '',
    '\\section{Fibonacci Sequence}',
    'The Fibonacci sequence is defined by the recurrence relation.',
    '',
    '\\input{chapters/main.tex}',
  ].join('\n');
  const next = [
    '\\section{Introduction}',
    "Hello from the sample project. Euler's identity: $e^{i\\pi} + 1 = 0$.",
    '',
    '\\begin{center}',
    '\\includegraphics[width=0.2\\linewidth]{favicon.png}',
    '\\end{center}',
    '',
    '\\section{Fibonacci Sequence}',
    'The Fibonacci sequence is defined by the recurrence relation.',
    '',
    '\\section{Navier--Stokes Equations}',
    'The incompressible Navier--Stokes equations.',
    '',
    '\\input{chapters/main.tex}',
  ].join('\n');
  const changes = diffHunk(old, next);
  expect(apply(old, changes)).toBe(next);
  // Two insertions, nothing removed, and the Fibonacci paragraph is not repeated.
  expect(changes.every((c) => c.from === c.to)).toBe(true);
  expect(changes.map((c) => c.insert.split('\n')[0])).toEqual([
    '\\begin{center}',
    '\\section{Navier--Stokes Equations}',
  ]);
  expect(changes.some((c) => c.insert.includes('Fibonacci'))).toBe(false);
});

test('pure deletions and identical text', () => {
  expect(apply('a\nb\nc\n', diffHunk('a\nb\nc\n', 'a\nc\n'))).toBe('a\nc\n');
  expect(diffHunk('a\nb\nc\n', 'a\nc\n')).toEqual([{ from: 2, to: 4, insert: '' }]);
  expect(diffHunk('same', 'same')).toEqual([]);
});

test('property: applying the changes always gives the new text', () => {
  const words = ['\\item', 'x', 'foo bar', '', '$a$', 'é', '\\section{A}', 'end'];
  let seed = 7;
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const text = () =>
    Array.from({ length: random(8) }, () => words[random(words.length)]).join(
      random(2) ? '\n' : ' ',
    );
  for (let k = 0; k < 500; k++) {
    const old = text();
    const next = text();
    expect(apply(old, diffHunk(old, next))).toBe(next);
  }
});
