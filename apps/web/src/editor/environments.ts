// \begin{…}/\end{…} pairs. Finishing a \begin{name} adds its \end{name}; renaming either half
// renames the other. Only the user's own typing does this: agent edits, undo and redo don't.

import { isolateHistory } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { EditorState, type Extension, type Text, type Transaction } from '@codemirror/state';

export interface EnvToken {
  kind: 'begin' | 'end';
  name: string;
  /** Range of the name inside the braces. */
  nameFrom: number;
  nameTo: number;
}

/** Environments whose \begin takes arguments: the cursor stays on that line to type them. */
const TAKES_ARGUMENTS = new Set([
  'array',
  'figure',
  'figure*',
  'longtable',
  'minipage',
  'multicols',
  'subfigure',
  'table',
  'table*',
  'tabular',
  'tabular*',
  'tabularx',
  'wrapfigure',
]);

/** A line's text before an unescaped %, so commented-out environments don't count. */
function uncommented(text: string): string {
  const match = /(?<!\\)%/.exec(text);
  return match ? text.slice(0, match.index) : text;
}

/** Every \begin{…} and \end{…} in `doc`, in order, outside comments. */
export function envTokens(doc: Text): EnvToken[] {
  const tokens: EnvToken[] = [];
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (!line.text.includes('\\')) continue;
    for (const match of uncommented(line.text).matchAll(/\\(begin|end)\{([^{}\n%\\]*)\}/g)) {
      const kind = match[1] as 'begin' | 'end';
      const name = match[2] as string;
      const nameFrom = line.from + match.index + kind.length + 2;
      tokens.push({ kind, name, nameFrom, nameTo: nameFrom + name.length });
    }
  }
  return tokens;
}

/** Index of the token pairing with `tokens[i]`, by nesting; -1 when unmatched. */
export function partnerOf(tokens: readonly EnvToken[], i: number): number {
  const token = tokens[i];
  if (!token) return -1;
  const step = token.kind === 'begin' ? 1 : -1;
  let depth = 0;
  for (let j = i + step; j >= 0 && j < tokens.length; j += step) {
    const other = tokens[j] as EnvToken;
    if (other.kind === token.kind) depth++;
    else if (depth > 0) depth--;
    else return other.name === token.name ? j : -1;
  }
  return -1;
}

const isTyping = (tr: Transaction) =>
  !tr.isUserEvent('input.agent') &&
  (tr.isUserEvent('input.type') || tr.isUserEvent('input.complete'));

/** The \begin/\end whose existing name this transaction edits (one change inside it), if any. */
function editedName(tr: Transaction): { tokens: EnvToken[]; index: number } | null {
  const changed: [number, number][] = [];
  tr.changes.iterChangedRanges((fromA, toA) => void changed.push([fromA, toA]));
  if (changed.length !== 1) return null;
  const [from, to] = changed[0] as [number, number];
  const line = tr.startState.doc.lineAt(from);
  if (to > line.to || !/\\(begin|end)\{/.test(line.text)) return null;
  const tokens = envTokens(tr.startState.doc);
  const index = tokens.findIndex((t) => from >= t.nameFrom && to <= t.nameTo);
  return index < 0 ? null : { tokens, index };
}

/** Typing the } of \begin{name} (or completing its name) adds a matching \end{name} below. */
const autoClose = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !isTyping(tr)) return tr;
  const { state } = tr;
  const range = state.selection.main;
  if (state.selection.ranges.length !== 1 || !range.empty) return tr;
  const line = state.doc.lineAt(range.head);
  const before = line.text.slice(0, range.head - line.from);
  let rest = line.text.slice(range.head - line.from);
  // Right after the }, or (a completed name) right before it.
  let match = /\\begin\{([^{}\s%\\]+)\}$/.exec(before);
  let end = range.head;
  if (!match && tr.isUserEvent('input.complete') && rest.startsWith('}')) {
    match = /\\begin\{([^{}\s%\\]+)$/.exec(before);
    end = range.head + 1;
    rest = rest.slice(1);
  }
  if (!match || rest.trim() !== '' || uncommented(before) !== before) return tr;
  const name = match[1] as string;
  const tokenFrom = range.head - match[0].length;
  let touched = false;
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (toB >= tokenFrom && fromB <= end) touched = true;
  });
  // Renaming an environment that was already closed is renamePartner's job.
  if (!touched || editedName(tr)) return tr;

  let open = 0;
  for (const token of envTokens(state.doc)) {
    if (token.name === name) open += token.kind === 'begin' ? 1 : -1;
  }
  if (open <= 0) return tr;

  const indent = /^\s*/.exec(line.text)?.[0] ?? '';
  const body = `\n${indent}${state.facet(indentUnit)}`;
  const cursor = TAKES_ARGUMENTS.has(name) ? end : end + body.length;
  return [
    tr,
    {
      changes: { from: end, to: line.to, insert: `${body}\n${indent}\\end{${name}}` },
      selection: { anchor: cursor },
      annotations: isolateHistory.of('before'),
      sequential: true,
    },
  ];
});

/** Editing the name of a \begin or \end renames its partner the same way. */
const renamePartner = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.isUserEvent('input.agent')) return tr;
  if (!tr.isUserEvent('input') && !tr.isUserEvent('delete')) return tr;
  const edited = editedName(tr);
  if (!edited) return tr;
  const { tokens, index } = edited;
  const j = partnerOf(tokens, index);
  if (j < 0) return tr;
  const token = tokens[index] as EnvToken;
  const partner = tokens[j] as EnvToken;
  const name = tr.newDoc.sliceString(
    tr.changes.mapPos(token.nameFrom, -1),
    tr.changes.mapPos(token.nameTo, 1),
  );
  if (/[{}\n%\\]/.test(name)) return tr;
  return [
    tr,
    {
      changes: {
        from: tr.changes.mapPos(partner.nameFrom),
        to: tr.changes.mapPos(partner.nameTo),
        insert: name,
      },
      sequential: true,
    },
  ];
});

export function environmentPairs(): Extension {
  return [autoClose, renamePartner];
}
