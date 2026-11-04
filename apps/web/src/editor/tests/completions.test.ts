import { expect, test } from 'bun:test';
import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';

import { labelsIn, latexCompletions } from '../completions.ts';

/** Completion at `|` in `text`. */
function complete(text: string, explicit = false) {
  const pos = text.indexOf('|');
  const state = EditorState.create({ doc: text.replace('|', '') });
  const result = latexCompletions(new CompletionContext(state, pos, explicit));
  return result && { from: result.from, labels: result.options.map((o) => o.label) };
}

test('environment names after \\begin{ and \\end{, replacing what is typed', () => {
  const result = complete('\\begin{ite|');
  expect(result?.from).toBe(7);
  expect(result?.labels).toContain('itemize');
  expect(complete('\\end{|')?.labels).toContain('document');
});

test('labels of the open file after \\ref{ and friends', () => {
  const doc = '\\section{A}\\label{sec:a}\n$x$\\label{eq:x} \\label{sec:a}\n';
  expect(labelsIn(doc)).toEqual(['sec:a', 'eq:x']);
  expect(complete(`${doc}see \\ref{s|`)).toEqual({
    from: doc.length + 9,
    labels: ['sec:a', 'eq:x'],
  });
  expect(complete(`${doc}\\eqref{|`)?.labels).toEqual(['sec:a', 'eq:x']);
  expect(complete(`${doc}\\cref{|`)?.labels).toEqual(['sec:a', 'eq:x']);
});

test('commands after a backslash and a letter; a lone backslash only when asked', () => {
  const result = complete('text \\sec|');
  expect(result?.from).toBe(5);
  expect(result?.labels).toContain('\\section');
  expect(complete('\\|')).toBeNull();
  expect(complete('\\|', true)?.labels).toContain('\\begin');
  expect(complete('plain words|')).toBeNull();
});
