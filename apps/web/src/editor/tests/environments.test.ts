import { describe, expect, test } from 'bun:test';
import { history, isolateHistory, redo, undo } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { EditorState, Text, type TransactionSpec } from '@codemirror/state';

import { environmentPairs, envTokens, partnerOf } from '../environments.ts';

/** A state whose doc is `text` with the cursor at `|`. */
function at(text: string): EditorState {
  const cursor = text.indexOf('|');
  return EditorState.create({
    doc: text.replace('|', ''),
    selection: { anchor: cursor < 0 ? 0 : cursor },
    extensions: [history(), environmentPairs(), indentUnit.of('  ')],
  });
}

/** The doc with `|` at the cursor. */
function show(state: EditorState): string {
  const head = state.selection.main.head;
  const doc = state.doc.toString();
  return `${doc.slice(0, head)}|${doc.slice(head)}`;
}

/** Types `text` at the cursor, one character per transaction, like the keyboard does. */
function type(state: EditorState, text: string): EditorState {
  for (const ch of text) {
    const { head } = state.selection.main;
    state = state.update({
      changes: { from: head, insert: ch },
      selection: { anchor: head + ch.length },
      userEvent: 'input.type',
    }).state;
  }
  return state;
}

function run(state: EditorState, command: typeof undo): EditorState {
  let next = state;
  command({ state, dispatch: (tr) => (next = tr.state) });
  return next;
}

const edit = (state: EditorState, spec: TransactionSpec) => state.update(spec).state;

describe('tokens and pairs', () => {
  test('finds \\begin/\\end outside comments, and pairs them by nesting', () => {
    const doc = Text.of([
      '\\begin{a} \\begin{b}',
      '% \\end{b} commented out',
      '\\begin{b}\\end{b} 50\\% \\end{b}',
      '\\end{a} \\end{zz}',
    ]);
    const tokens = envTokens(doc);
    expect(tokens.map((t) => `${t.kind}:${t.name}`)).toEqual([
      'begin:a',
      'begin:b',
      'begin:b',
      'end:b',
      'end:b',
      'end:a',
      'end:zz',
    ]);
    expect(doc.sliceString(tokens[0]!.nameFrom, tokens[0]!.nameTo)).toBe('a');
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => partnerOf(tokens, i))).toEqual([5, 4, 3, 2, 1, 0, -1]);
  });

  test('a mismatched name does not pair', () => {
    const tokens = envTokens(Text.of(['\\begin{a}', '\\end{b}']));
    expect(partnerOf(tokens, 0)).toBe(-1);
    expect(partnerOf(tokens, 1)).toBe(-1);
  });
});

describe('auto-close', () => {
  test('typing the } of \\begin{itemize} adds \\end{itemize} with the cursor inside', () => {
    expect(show(type(at('|'), '\\begin{itemize}'))).toBe('\\begin{itemize}\n  |\n\\end{itemize}');
  });

  test('keeps the indentation of the \\begin line', () => {
    const state = type(at('\\begin{document}\n  |\n\\end{document}'), '\\begin{center}');
    expect(show(state)).toBe(
      '\\begin{document}\n  \\begin{center}\n    |\n  \\end{center}\n\\end{document}',
    );
  });

  test('environments that take arguments keep the cursor after the }', () => {
    expect(show(type(at('|'), '\\begin{tabular}'))).toBe('\\begin{tabular}|\n  \n\\end{tabular}');
    expect(show(type(at('|'), '\\begin{figure}'))).toBe('\\begin{figure}|\n  \n\\end{figure}');
  });

  test('not when the environment is already closed below', () => {
    const state = type(at('\\begin{itemize|\n  \\item x\n\\end{itemize}'), '}');
    expect(show(state)).toBe('\\begin{itemize}|\n  \\item x\n\\end{itemize}');
  });

  test('nested: an inner \\begin of the same name still gets its own \\end', () => {
    const state = type(at('\\begin{itemize}\n  |\n\\end{itemize}'), '\\begin{itemize}');
    expect(show(state)).toBe(
      '\\begin{itemize}\n  \\begin{itemize}\n    |\n  \\end{itemize}\n\\end{itemize}',
    );
  });

  test('not with text after the cursor, inside a comment, or for a pasted line', () => {
    expect(show(type(at('| text'), '\\begin{quote}'))).toBe('\\begin{quote}| text');
    expect(show(type(at('% |'), '\\begin{quote}'))).toBe('% \\begin{quote}|');
    const pasted = edit(at('|'), {
      changes: { from: 0, insert: '\\begin{quote}' },
      selection: { anchor: 13 },
      userEvent: 'input.paste',
    });
    expect(show(pasted)).toBe('\\begin{quote}|');
  });

  test('agent edits are left exactly as proposed', () => {
    const state = edit(at('|'), {
      changes: { from: 0, insert: '\\begin{quote}' },
      selection: { anchor: 13 },
      userEvent: 'input.agent',
      annotations: isolateHistory.of('full'),
    });
    expect(state.doc.toString()).toBe('\\begin{quote}');
  });

  test('completing the name before an existing } also closes it', () => {
    const start = at('\\begin{ite|}');
    const completed = edit(start, {
      changes: { from: 7, to: 10, insert: 'itemize' },
      selection: { anchor: 14 },
      userEvent: 'input.complete',
    });
    // `\begin{ite}` already was a whole token: completing its name is a rename, not a new env.
    expect(show(completed)).toBe('\\begin{itemize|}');
    const fresh = edit(at('\\begin{ite|'), {
      changes: { from: 7, to: 10, insert: 'itemize}' },
      selection: { anchor: 15 },
      userEvent: 'input.complete',
    });
    expect(show(fresh)).toBe('\\begin{itemize}\n  |\n\\end{itemize}');
  });

  test('one undo removes the } and the added \\end; redo brings both back', () => {
    const typed = type(at('|'), '\\begin{itemize}');
    const undone = run(typed, undo);
    expect(show(undone)).toBe('\\begin{itemize|');
    expect(run(undone, redo).doc.toString()).toBe('\\begin{itemize}\n  \n\\end{itemize}');
    // Undo does not re-trigger the auto-close.
    expect(run(run(undone, redo), undo).doc.toString()).toBe('\\begin{itemize');
  });
});

describe('renaming a pair', () => {
  const pair = '\\begin{itemize}\n  \\item a\n\\end{itemize}';

  test('typing in the \\begin name renames the \\end', () => {
    const state = type(at(pair.replace('itemize}', 'itemize|}')), 'd');
    expect(state.doc.toString()).toBe('\\begin{itemized}\n  \\item a\n\\end{itemized}');
    expect(state.selection.main.head).toBe('\\begin{itemized'.length);
  });

  test('editing the \\end name renames the \\begin, and the cursor stays put', () => {
    const start = at(pair);
    const endName = pair.lastIndexOf('itemize');
    const state = edit(start, {
      changes: { from: endName, to: endName + 7, insert: 'enumerate' },
      selection: { anchor: endName + 9 },
      userEvent: 'input.type',
    });
    expect(state.doc.toString()).toBe('\\begin{enumerate}\n  \\item a\n\\end{enumerate}');
    expect(state.selection.main.head).toBe(state.doc.length - 1);
  });

  test('deleting characters, down to an empty name and back', () => {
    let state = at(pair.replace('{itemize}', '{itemize|}'));
    for (let i = 0; i < 7; i++) {
      const { head } = state.selection.main;
      state = edit(state, {
        changes: { from: head - 1, to: head },
        selection: { anchor: head - 1 },
        userEvent: 'delete.backward',
      });
    }
    expect(state.doc.toString()).toBe('\\begin{}\n  \\item a\n\\end{}');
    state = type(state, 'quote');
    expect(state.doc.toString()).toBe('\\begin{quote}\n  \\item a\n\\end{quote}');
  });

  test('the rename is one undo step with the typing', () => {
    const state = type(at(pair.replace('itemize}', 'itemize|}')), 'd');
    expect(run(state, undo).doc.toString()).toBe(pair);
  });

  test('pairs by nesting: renaming the outer leaves the inner alone', () => {
    const nested = '\\begin{a}\n\\begin{a}\n\\end{a}\n\\end{a}';
    const state = type(at(nested.replace('{a}', '{a|}')), 'x');
    expect(state.doc.toString()).toBe('\\begin{ax}\n\\begin{a}\n\\end{a}\n\\end{ax}');
  });

  test('no partner, a change outside the name, or an agent edit: nothing else changes', () => {
    expect(type(at('\\begin{a|}'), 'b').doc.toString()).toBe('\\begin{ab}');
    expect(type(at(`${pair}|`), ' x').doc.toString()).toBe(`${pair} x`);
    const agent = edit(at(pair), {
      changes: { from: 7, to: 14, insert: 'enumerate' },
      userEvent: 'input.agent',
    });
    expect(agent.doc.toString()).toBe('\\begin{enumerate}\n  \\item a\n\\end{itemize}');
  });

  test('typing a brace into the name does not spread to the partner', () => {
    const state = type(at(pair.replace('itemize}', 'item|ize}')), '}');
    expect(state.doc.toString()).toBe('\\begin{item}ize}\n  \\item a\n\\end{itemize}');
  });
});
