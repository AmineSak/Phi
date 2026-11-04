/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { CompileResult } from '@phi/shared';

import { locatedEntries, numberEntries } from '../entries.ts';

const result = (over: Partial<CompileResult>): CompileResult => ({
  root: 'main.tex',
  ok: false,
  durationMs: 100,
  errors: [],
  warnings: [],
  logTail: '',
  ...over,
});

const undefinedFoo = { file: 'main.tex', line: 8, message: 'Undefined control sequence \\foo' };
const missingEnd = { file: 'chapters/a.tex', line: 3, message: 'Missing \\end{itemize}' };
const citation = { file: '', line: 4, message: "Citation `x' undefined" };

describe('numberEntries', () => {
  test('numbers errors E1… and warnings W1… in build order', () => {
    const entries = numberEntries(
      result({ errors: [undefinedFoo, missingEnd], warnings: [citation] }),
    );
    expect(entries.map((e) => [e.id, e.kind, e.message])).toEqual([
      ['E1', 'error', undefinedFoo.message],
      ['E2', 'error', missingEnd.message],
      ['W1', 'warning', citation.message],
    ]);
  });

  test('nothing is new on the first build', () => {
    expect(numberEntries(result({ errors: [undefinedFoo] }))[0]?.isNew).toBe(false);
  });

  test('marks entries the previous build did not have, ignoring line shifts', () => {
    const first = numberEntries(result({ errors: [undefinedFoo] }));
    const second = numberEntries(
      result({ errors: [{ ...undefinedFoo, line: 12 }, missingEnd], warnings: [citation] }),
      first,
    );
    expect(second.map((e) => [e.id, e.isNew])).toEqual([
      ['E1', false],
      ['E2', true],
      ['W1', true],
    ]);
  });

  test('after a clean build, every entry of the next build is new', () => {
    const clean = numberEntries(result({ ok: true }), null);
    expect(clean).toEqual([]);
    expect(numberEntries(result({ errors: [undefinedFoo] }), clean)[0]?.isNew).toBe(true);
  });

  test('the same message as a warning and as an error are different entries', () => {
    const first = numberEntries(result({ warnings: [undefinedFoo] }));
    expect(numberEntries(result({ errors: [undefinedFoo] }), first)[0]?.isNew).toBe(true);
  });
});

test('locatedEntries keeps entries with a line in the given file', () => {
  const entries = numberEntries(
    result({
      errors: [
        undefinedFoo,
        missingEnd,
        { file: 'main.tex', line: null, message: 'Emergency stop' },
      ],
      warnings: [citation],
    }),
  );
  expect(locatedEntries(entries, 'main.tex').map((e) => e.id)).toEqual(['E1']);
  expect(locatedEntries(entries, 'chapters/a.tex').map((e) => e.id)).toEqual(['E2']);
});
