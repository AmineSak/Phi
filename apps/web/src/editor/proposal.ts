// An agent's edit proposal shown inside the file it changes (SPEC 3.1-3.4): each hunk's
// current text struck through in red, the proposed text in green right after it, with Accept,
// Reject and Edit on each hunk. The document itself is untouched until the proposal is
// finished; then the accepted hunks are applied together (agent/reviews.ts). No React here.

import {
  StateEffect,
  StateField,
  type EditorState,
  type Range,
  type Transaction,
} from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

export type HunkStatus = 'pending' | 'accepted' | 'rejected';

export interface InlineHunk {
  /** Index into the proposal's hunks. */
  index: number;
  /** Where the hunk's original text is in the current document; null if it wasn't found. */
  from: number | null;
  to: number | null;
  /** The proposal's text for it, or the user's edit of it. */
  newText: string;
  status: HunkStatus;
  /** The user changed this text after the proposal arrived: it can't be applied any more. */
  stale: boolean;
}

export interface InlineProposal {
  id: string;
  hunks: InlineHunk[];
}

export type HunkAction =
  { kind: 'accept' } | { kind: 'reject' } | { kind: 'undo' } | { kind: 'edit'; text: string };

/** What a click on a hunk's button does; set by agent/reviews.ts. */
let onHunkAction: (proposalId: string, index: number, action: HunkAction) => void = () => {};

export function setHunkActionHandler(
  handler: (proposalId: string, index: number, action: HunkAction) => void,
): void {
  onHunkAction = handler;
}

export const showProposal = StateEffect.define<InlineProposal>();
export const clearProposal = StateEffect.define<null>();
export const updateHunk = StateEffect.define<{
  index: number;
  status?: HunkStatus;
  newText?: string;
}>();

/** Moves hunks along with edits; an edit touching a hunk's text makes it stale. */
function mapHunks(proposal: InlineProposal, tr: Transaction): InlineProposal {
  return {
    ...proposal,
    hunks: proposal.hunks.map((h) => {
      if (h.from === null || h.to === null) return h;
      let touched = false;
      tr.changes.iterChangedRanges((fromA, toA) => {
        const overlaps = fromA < h.to! && toA > h.from!;
        const insertsInside = fromA === toA && fromA > h.from! && fromA < h.to!;
        if (overlaps || insertsInside) touched = true;
      });
      const from = tr.changes.mapPos(h.from, 1);
      const to = Math.max(from, tr.changes.mapPos(h.to, -1));
      return { ...h, from, to, stale: h.stale || (touched && h.status !== 'rejected') };
    }),
  };
}

export const proposalField: StateField<InlineProposal | null> =
  StateField.define<InlineProposal | null>({
    create: () => null,
    update(value, tr) {
      let next = value && tr.docChanged ? mapHunks(value, tr) : value;
      for (const effect of tr.effects) {
        if (effect.is(showProposal)) next = effect.value;
        else if (effect.is(clearProposal)) next = null;
        else if (effect.is(updateHunk) && next) {
          const { index, status, newText } = effect.value;
          next = {
            ...next,
            hunks: next.hunks.map((h) =>
              h.index === index
                ? {
                    ...h,
                    ...(status ? { status } : {}),
                    ...(newText !== undefined ? { newText } : {}),
                  }
                : h,
            ),
          };
        }
      }
      return next;
    },
    provide: (field) => EditorView.decorations.compute([field], decorate),
  });

/** The proposal shown in `state`, if any. */
export const inlineProposal = (state: EditorState) => state.field(proposalField, false) ?? null;

function button(
  label: string,
  className: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  el.title = title;
  el.className = `cm-proposal-btn ${className}`;
  el.setAttribute('aria-label', title);
  // mousedown would move the editor's selection; the click is all we want.
  el.addEventListener('mousedown', (e) => e.preventDefault());
  el.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
  });
  return el;
}

/** One minimal replacement inside a hunk, in offsets of the hunk's old text. */
export interface HunkChange {
  from: number;
  to: number;
  insert: string;
}

/** Hunks bigger than this many lines on a side are shown as one change (the diff is O(n·m)). */
const MAX_DIFF_LINES = 400;

/** Lines of `text`, each keeping its "\n" (the last may have none). */
const linesOf = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/**
 * The smallest changes that turn `oldText` into `newText`, so only what differs is marked
 * (like Prism): within one line, the changed words; across lines, a line diff (LCS), where a
 * changed line is a deleted line plus an inserted one. Applying them to `oldText` gives
 * `newText` exactly.
 */
export function diffHunk(oldText: string, newText: string): HunkChange[] {
  if (oldText === newText) return [];
  if (!oldText.includes('\n') && !newText.includes('\n')) return [diffWords(oldText, newText)];

  const a = linesOf(oldText);
  const b = linesOf(newText);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [{ from: 0, to: oldText.length, insert: newText }];
  }
  // lcs[i][j]: length of the longest common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const changes: HunkChange[] = [];
  let i = 0;
  let j = 0;
  let offset = 0;
  let current: HunkChange | null = null;
  const flush = () => {
    if (current) changes.push(current);
    current = null;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      offset += a[i]!.length;
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      current ??= { from: offset, to: offset, insert: '' };
      current.insert += b[j]!;
      j++;
    } else {
      current ??= { from: offset, to: offset, insert: '' };
      offset += a[i]!.length;
      current.to = offset;
      i++;
    }
  }
  flush();
  return changes;
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}_\\]/u.test(c);

/** One change within a line: the common start and end trimmed, widened to whole words. */
function diffWords(oldText: string, newText: string): HunkChange {
  let start = 0;
  const max = Math.min(oldText.length, newText.length);
  while (start < max && oldText[start] === newText[start]) start++;
  let end = 0;
  while (
    end < max - start &&
    oldText[oldText.length - 1 - end] === newText[newText.length - 1 - end]
  ) {
    end++;
  }
  // Don't split a word: "Hello" -> "Hallo" shows the whole word changed.
  while (start > 0 && isWordChar(oldText[start - 1]) && isWordChar(oldText[start])) start--;
  while (
    end > 0 &&
    isWordChar(oldText[oldText.length - end]) &&
    isWordChar(oldText[oldText.length - end - 1])
  ) {
    end--;
  }
  return {
    from: start,
    to: oldText.length - end,
    insert: newText.slice(start, newText.length - end),
  };
}

/**
 * Inserted text (green), as an inline span or a block under a line. The last widget of a hunk
 * also carries its buttons: Accept / Reject / Edit while pending, Undo once accepted.
 */
class InsertWidget extends WidgetType {
  constructor(
    readonly proposalId: string,
    readonly hunk: InlineHunk,
    readonly text: string,
    readonly block: boolean,
    readonly withActions: boolean,
  ) {
    super();
  }

  override eq(other: InsertWidget) {
    return (
      other.proposalId === this.proposalId &&
      other.hunk.index === this.hunk.index &&
      other.hunk.status === this.hunk.status &&
      other.hunk.stale === this.hunk.stale &&
      other.hunk.newText === this.hunk.newText &&
      other.text === this.text &&
      other.block === this.block &&
      other.withActions === this.withActions
    );
  }

  toDOM() {
    const { proposalId, hunk } = this;
    const root = document.createElement(this.block ? 'div' : 'span');
    root.className = [
      'cm-proposal-insert',
      this.block ? 'cm-proposal-block' : '',
      hunk.status === 'accepted' ? 'cm-proposal-accepted' : 'cm-proposal-suggestion',
    ].join(' ');
    root.dataset.hunk = String(hunk.index);
    if (this.text) {
      const text = document.createElement(this.block ? 'div' : 'span');
      text.className = 'cm-proposal-new';
      text.textContent = this.text;
      root.append(text);
    }
    if (this.withActions) root.append(this.actions());
    return root;
  }

  private actions(): HTMLElement {
    const { proposalId, hunk } = this;
    const bar = document.createElement('span');
    bar.className = 'cm-proposal-actions';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', `Suggested change ${hunk.index + 1}`);
    const act = (action: HunkAction) => onHunkAction(proposalId, hunk.index, action);
    if (hunk.status === 'accepted') {
      bar.append(
        button('Undo', 'cm-proposal-undo', 'Undo accepting this change', () =>
          act({ kind: 'undo' }),
        ),
      );
      return bar;
    }
    if (hunk.stale) {
      const note = document.createElement('span');
      note.className = 'cm-proposal-note';
      note.textContent = 'You changed this text since';
      bar.append(
        note,
        button('Reject', 'cm-proposal-reject', 'Reject this change', () => act({ kind: 'reject' })),
      );
      return bar;
    }
    bar.append(
      button('Accept', 'cm-proposal-accept', 'Accept this change', () => act({ kind: 'accept' })),
      button('Reject', 'cm-proposal-reject', 'Reject this change', () => act({ kind: 'reject' })),
      button('Edit', 'cm-proposal-edit', 'Edit the proposed text', () => {
        // The whole hunk's new text in a box; Save keeps it pending with that text.
        const box = document.createElement('textarea');
        box.className = 'cm-proposal-input';
        box.value = hunk.newText;
        box.rows = Math.min(10, hunk.newText.split('\n').length + 1);
        box.setAttribute('aria-label', 'Proposed text');
        const editor = document.createElement('div');
        editor.className = 'cm-proposal-editing';
        const buttons = document.createElement('span');
        buttons.className = 'cm-proposal-actions';
        buttons.append(
          button('Save', 'cm-proposal-accept', 'Save the edited text', () =>
            act({ kind: 'edit', text: box.value }),
          ),
          button('Cancel', 'cm-proposal-reject', 'Keep the proposed text', () =>
            act({ kind: 'edit', text: hunk.newText }),
          ),
        );
        editor.append(box, buttons);
        bar.replaceWith(editor);
        box.focus();
      }),
    );
    return bar;
  }

  override ignoreEvent() {
    return true; // the buttons and the text box handle their own events
  }
}

/**
 * Each pending hunk as its minimal changes (diffHunk): removed text struck through in red,
 * inserted text in green right after it (a block under the line when it spans lines). An
 * accepted hunk hides its removed text and keeps its inserted text, until the proposal is
 * finished. Rejected hunks and hunks not found show nothing.
 */
function decorate(state: EditorState): DecorationSet {
  const proposal = inlineProposal(state);
  if (!proposal) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  const removed = Decoration.mark({ class: 'cm-proposal-old' });
  for (const hunk of proposal.hunks) {
    if (hunk.from === null || hunk.to === null || hunk.status === 'rejected') continue;
    const base = hunk.from;
    const changes = diffHunk(state.sliceDoc(hunk.from, hunk.to), hunk.newText);
    // Nothing differs (e.g. the user typed the proposal already): still offer the buttons.
    if (changes.length === 0)
      changes.push({ from: hunk.to - base, to: hunk.to - base, insert: '' });
    changes.forEach((change, n) => {
      const from = base + change.from;
      const to = base + change.to;
      const last = n === changes.length - 1;
      if (to > from) {
        ranges.push(
          hunk.status === 'accepted'
            ? Decoration.replace({}).range(from, to)
            : removed.range(from, to),
        );
      }
      if (!change.insert && !last) return;
      const text = change.insert.replace(/\n$/, '');
      const multiline = change.insert.includes('\n') || state.sliceDoc(from, to).includes('\n');
      const widget = new InsertWidget(proposal.id, hunk, text, multiline, last);
      if (!multiline) {
        ranges.push(Decoration.widget({ widget, side: 1 }).range(to));
        return;
      }
      // A block goes between lines: before the line starting at `to`, or after `to`'s line.
      const line = state.doc.lineAt(to);
      ranges.push(
        to === line.from && to > 0
          ? Decoration.widget({ widget, block: true, side: -1 }).range(to)
          : Decoration.widget({ widget, block: true, side: 1 }).range(line.to),
      );
    });
  }
  return Decoration.set(ranges, true);
}

/** Colours: removed text in the destructive red, proposed text in --diff-added green. */
export const proposalTheme = EditorView.baseTheme({
  '.cm-proposal-old': {
    backgroundColor: 'color-mix(in oklch, var(--destructive) 14%, transparent)',
    textDecoration: 'line-through',
    textDecorationColor: 'color-mix(in oklch, var(--destructive) 70%, transparent)',
  },
  '.cm-proposal-insert .cm-proposal-new': {
    backgroundColor: 'color-mix(in oklch, var(--diff-added) 16%, transparent)',
    borderRadius: '3px',
  },
  '.cm-proposal-accepted .cm-proposal-new': {
    backgroundColor: 'color-mix(in oklch, var(--diff-added) 10%, transparent)',
  },
  '.cm-proposal-block': {
    margin: '0 16px 0 8px',
    padding: '0 0 0 6px',
    borderLeft: '2px solid var(--diff-added)',
  },
  '.cm-proposal-block .cm-proposal-new': { display: 'block' },
  '.cm-proposal-editing': { display: 'block', margin: '4px 0' },
  '.cm-proposal-new': { whiteSpace: 'pre-wrap', color: 'var(--foreground)' },
  '.cm-proposal-actions': {
    display: 'inline-flex',
    gap: '4px',
    marginLeft: '6px',
    verticalAlign: 'baseline',
    fontFamily: 'var(--font-sans)',
  },
  '.cm-proposal-block .cm-proposal-actions': { display: 'flex', marginLeft: '0', marginTop: '4px' },
  '.cm-proposal-btn': {
    font: '500 11px/1.6 var(--font-sans)',
    padding: '0 6px',
    borderRadius: '4px',
    border: '1px solid var(--border)',
    background: 'var(--background)',
    color: 'var(--foreground)',
    cursor: 'pointer',
  },
  '.cm-proposal-btn:hover': { borderColor: 'var(--ring)' },
  '.cm-proposal-btn:focus-visible': { outline: '2px solid var(--ring)', outlineOffset: '1px' },
  '.cm-proposal-accept': {
    background: 'var(--primary)',
    borderColor: 'var(--primary)',
    color: 'var(--primary-foreground)',
  },
  '.cm-proposal-note': { font: '11px var(--font-sans)', color: 'var(--warning)' },
  '.cm-proposal-input': {
    display: 'block',
    width: '100%',
    font: 'inherit',
    background: 'var(--background)',
    color: 'var(--foreground)',
    border: '1px solid var(--ring)',
    borderRadius: '4px',
    padding: '2px 4px',
  },
});
