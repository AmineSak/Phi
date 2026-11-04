/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { applyEdits, EditMatchError, lineAt } from '../edit-match.ts';

const DOC = [
  '\\section{Results}',
  "We call this ``the method'' in what follows.",
  'Accuracy rose by 12\\% overall.',
  '\\begin{itemize}',
  '  \\item First point',
  '  \\item',
  '  \\item',
  '\\end{itemize}',
  '',
].join('\n');

describe('exact matches', () => {
  test('replaces each oldText; hunks carry original offsets, sorted', () => {
    const { newContent, hunks } = applyEdits(DOC, [
      { oldText: '12\\% overall', newText: '15\\% overall' },
      { oldText: "``the method''", newText: "``our method''" },
    ]);
    expect(newContent).toContain("``our method''");
    expect(newContent).toContain('15\\% overall');
    expect(hunks.map((h) => h.oldText)).toEqual(["``the method''", '12\\% overall']);
    for (const h of hunks) expect(DOC.slice(h.start, h.end)).toBe(h.oldText);
  });

  test('every oldText is matched against the original, not after earlier edits', () => {
    const { newContent } = applyEdits('alpha beta', [
      { oldText: 'alpha', newText: 'beta' },
      { oldText: 'beta', newText: 'gamma' },
    ]);
    expect(newContent).toBe('beta gamma');
  });

  test('deleting text and LaTeX specials (\\%, quotes, braces) are plain text', () => {
    const { newContent } = applyEdits(DOC, [{ oldText: ' overall', newText: '' }]);
    expect(newContent).toContain('Accuracy rose by 12\\%.');
  });
});

describe('ambiguity and errors', () => {
  test('repeated \\item lines: several matches asks for more context, with the lines', () => {
    expect(() =>
      applyEdits(DOC, [{ oldText: '  \\item\n', newText: '  \\item Second\n' }]),
    ).toThrow('Edit 1: oldText occurs 2 times (lines 6, 7); include more surrounding text');
    // With context it matches once.
    const { newContent } = applyEdits(DOC, [
      { oldText: '  \\item\n\\end{itemize}', newText: '  \\item Third\n\\end{itemize}' },
    ]);
    expect(newContent).toContain('  \\item\n  \\item Third\n\\end{itemize}');
  });

  test('no match names the edit and says to re-read', () => {
    let error: unknown;
    try {
      applyEdits(DOC, [
        { oldText: 'Results', newText: 'Findings' },
        { oldText: 'not in the file', newText: 'x' },
      ]);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(EditMatchError);
    expect((error as Error).message).toBe(
      'Edit 2: oldText was not found in the file. Re-read the file and copy the text to replace exactly.',
    );
  });

  test('overlapping edits are refused', () => {
    expect(() =>
      applyEdits(DOC, [
        { oldText: 'Accuracy rose', newText: 'A' },
        { oldText: 'rose by 12', newText: 'B' },
      ]),
    ).toThrow('Edits 1 and 2 overlap (line 3); merge them into one edit.');
  });

  test('empty oldText and empty edit lists are refused', () => {
    expect(() => applyEdits(DOC, [{ oldText: '', newText: 'x' }])).toThrow('oldText is empty');
    expect(() => applyEdits(DOC, [])).toThrow('No edits given.');
  });
});

describe('fuzzy matches map back to original offsets', () => {
  test('curly quotes and dashes in oldText match ASCII in the file', () => {
    const content = "He said 'yes' -- twice.\n";
    const { hunks, newContent } = applyEdits(content, [
      { oldText: 'He said \u2018yes\u2019 \u2013\u2013 twice', newText: 'He agreed twice' },
    ]);
    expect(hunks[0]).toMatchObject({ start: 0, oldText: "He said 'yes' -- twice" });
    expect(newContent).toBe('He agreed twice.\n');
  });

  test('curly quotes in the file match ASCII in oldText', () => {
    const content = 'A \u201cquoted\u201d word.';
    const { newContent } = applyEdits(content, [{ oldText: 'A "quoted" word', newText: 'A word' }]);
    expect(newContent).toBe('A word.');
  });

  test('trailing whitespace and CRLF are ignored, the rest of the file is untouched', () => {
    const content = 'first line   \r\nsecond line\t\r\nthird\r\n';
    const { hunks, newContent } = applyEdits(content, [
      { oldText: 'first line\nsecond line', newText: 'merged line' },
    ]);
    expect(hunks[0]!.oldText).toBe('first line   \r\nsecond line');
    expect(newContent).toBe('merged line\t\r\nthird\r\n');
  });

  test('fuzzy matching can be ambiguous too', () => {
    expect(() =>
      applyEdits('it\u2019s here\nit\u2019s there\n', [{ oldText: "it's", newText: 'it is' }]),
    ).toThrow('occurs 2 times (lines 1, 2)');
  });
});

test('the diff shows whole changed lines with context and line numbers', () => {
  const content = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
  const { diff } = applyEdits(content, [
    { oldText: 'c', newText: 'C1\nC2' },
    { oldText: 'g', newText: 'G' },
  ]);
  expect(diff).toBe(
    [
      '@@ -1,5 +1,6 @@',
      ' a',
      ' b',
      '-c',
      '+C1',
      '+C2',
      ' d',
      ' e',
      '@@ -5,4 +6,4 @@',
      ' e',
      ' f',
      '-g',
      '+G',
      ' h',
    ].join('\n'),
  );
});

test('lineAt counts from 1', () => {
  expect(lineAt('a\nb\nc', 0)).toBe(1);
  expect(lineAt('a\nb\nc', 2)).toBe(2);
  expect(lineAt('a\nb\nc', 4)).toBe(3);
});
