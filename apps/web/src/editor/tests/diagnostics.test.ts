/// <reference types="bun" />
import { expect, test } from 'bun:test';

import { Text } from '@codemirror/state';

import { toDiagnostics } from '../diagnostics.ts';
import type { Entry } from '../entries.ts';

const doc = Text.of([
  '\\documentclass{article}', // 1
  '\\begin{document}', // 2
  '  We study \\sparsenorm{x} here.', // 3
  '', // 4
  '\\end{document}', // 5
]);

const entry = (over: Partial<Entry>): Entry => ({
  id: 'E1',
  kind: 'error',
  file: 'main.tex',
  line: 3,
  message: 'Something went wrong',
  isNew: false,
  ...over,
});

const range = (from: number, to: number) => doc.sliceString(from, to);

test('marks the line from its first non-blank character, carrying the entry id as source', () => {
  const [d] = toDiagnostics(doc, [entry({})]);
  expect(d).toMatchObject({ severity: 'error', source: 'E1', message: 'Something went wrong' });
  expect(range(d!.from, d!.to)).toBe('We study \\sparsenorm{x} here.');
});

test('narrows to the undefined macro when the line contains it', () => {
  const [d] = toDiagnostics(doc, [entry({ message: 'Undefined control sequence \\sparsenorm' })]);
  expect(range(d!.from, d!.to)).toBe('\\sparsenorm');
});

test('falls back to the whole line when the named macro is not on it', () => {
  const [d] = toDiagnostics(doc, [entry({ line: 2, message: 'Undefined control sequence \\foo' })]);
  expect(range(d!.from, d!.to)).toBe('\\begin{document}');
});

test('warnings map to warning severity', () => {
  expect(toDiagnostics(doc, [entry({ id: 'W1', kind: 'warning' })])[0]).toMatchObject({
    severity: 'warning',
    source: 'W1',
  });
});

test('an empty line gives an empty range at the line start', () => {
  const [d] = toDiagnostics(doc, [entry({ line: 4 })]);
  expect(d!.from).toBe(d!.to);
  expect(d!.from).toBe(doc.line(4).from);
});

test('lines past the end clamp to the last line; entries without a line are skipped', () => {
  const ds = toDiagnostics(doc, [entry({ line: 99 }), entry({ id: 'E2', line: null })]);
  expect(ds).toHaveLength(1);
  expect(range(ds[0]!.from, ds[0]!.to)).toBe('\\end{document}');
});
