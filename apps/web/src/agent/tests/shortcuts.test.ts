import { expect, test } from 'bun:test';

import { MAX_SELECTION_CHARS } from '@phi/shared';

import { fixErrorMessage, quoteSelection } from '../shortcuts.ts';

test('quoteSelection quotes each line and leaves room for the question', () => {
  expect(
    quoteSelection({ path: 'chapters/intro.tex', from: 3, to: 5, text: 'One.\n\nTwo.\n' }),
  ).toBe('About chapters/intro.tex, lines 3-5:\n> One.\n>\n> Two.\n\n');
  expect(quoteSelection({ path: 'a.tex', from: 2, to: 2, text: 'x' })).toBe(
    'About a.tex, line 2:\n> x\n\n',
  );
});

test('quoteSelection cuts a long selection', () => {
  const quote = quoteSelection({ path: 'a.tex', from: 1, to: 1, text: 'z'.repeat(5000) });
  expect(quote).toContain(`${'z'.repeat(MAX_SELECTION_CHARS)}…`);
  expect(quote).not.toContain('z'.repeat(MAX_SELECTION_CHARS + 1));
});

test('fixErrorMessage uses <file>:<line>: <message>, dropping missing parts', () => {
  expect(
    fixErrorMessage({ file: 'main.tex', line: 12, message: 'Undefined control sequence.' }),
  ).toBe('Fix this compile error: main.tex:12: Undefined control sequence.');
  expect(fixErrorMessage({ file: 'main.tex', line: null, message: 'Emergency stop.' })).toBe(
    'Fix this compile error: main.tex: Emergency stop.',
  );
  expect(fixErrorMessage({ file: '', line: null, message: 'Timed out' })).toBe(
    'Fix this compile error: Timed out',
  );
});
