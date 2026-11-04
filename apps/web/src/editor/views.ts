// The single EditorView and one EditorState per opened file. CodeMirror owns document
// state; zustand only mirrors metadata (dirty flags, active path).

import { isolateHistory } from '@codemirror/commands';
import { setDiagnostics } from '@codemirror/lint';
import {
  EditorSelection,
  EditorState,
  type ChangeSpec,
  type Text,
  type TransactionSpec,
} from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { api } from '../api/client.ts';
import { toDiagnostics } from './diagnostics.ts';
import { locatedEntries, type Entry } from './entries.ts';
import { activeEntryField, latexExtensions, setActiveEntry } from './extensions.ts';
import { lspCompartment, lspExtension, lspForget, onLspChange, setDocSource } from './lsp.ts';
import {
  clearProposal,
  inlineProposal,
  proposalField,
  proposalTheme,
  showProposal,
  updateHunk,
  type InlineProposal,
} from './proposal.ts';

interface FileRecord {
  /** Shared with the state's update listener, so a rename re-targets autosave. */
  ref: { path: string };
  state: EditorState;
  /** Document as last written to (or read from) disk. */
  savedDoc: Text;
  /** Disk mtime that `savedDoc` corresponds to. */
  mtimeMs: number;
}

const files = new Map<string, FileRecord>();
const loading = new Map<string, Promise<void>>();
const changeListeners = new Set<(path: string) => void>();
const selectionListeners = new Set<() => void>();
const proposalListeners = new Set<(path: string) => void>();

let view: EditorView | null = null;
let activePath: string | null = null;
let entries: readonly Entry[] = [];
let onSelectEntry: (id: string) => void = () => {};
let onShowInPdf: () => void = () => {};

function notifyChange(path: string): void {
  for (const listener of changeListeners) listener(path);
}

function createState(ref: { path: string }, content: string): EditorState {
  return EditorState.create({
    doc: content,
    extensions: [
      latexExtensions(
        (id) => onSelectEntry(id),
        () => onShowInPdf(),
      ),
      proposalField,
      proposalTheme,
      lspCompartment.of(lspExtension(ref.path)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) notifyChange(ref.path);
        if (update.selectionSet) for (const listener of selectionListeners) listener();
        if (inlineProposal(update.startState) !== inlineProposal(update.state)) {
          for (const listener of proposalListeners) listener(ref.path);
        }
      }),
    ],
  });
}

/** What the view shows when no file is open: empty and not editable. */
function emptyState(): EditorState {
  return EditorState.create({
    extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false)],
  });
}

/** Current state of a loaded file, including unsaved edits in the live view. */
function currentState(path: string): EditorState | undefined {
  if (path === activePath && view) return view.state;
  return files.get(path)?.state;
}

/** Runs `update` on a file's state, through the view when it is the visible one. */
function updateState(path: string, spec: TransactionSpec): void {
  if (path === activePath && view) {
    view.dispatch(spec);
    return;
  }
  const record = files.get(path);
  if (!record) return;
  const tr = record.state.update(spec);
  record.state = tr.state;
  if (tr.docChanged) notifyChange(path);
}

/** Points a file's completion at texlab, or back to the fallback (also after a rename). */
function reconfigureLsp(path: string): void {
  updateState(path, { effects: lspCompartment.reconfigure(lspExtension(path)) });
}

setDocSource((path) => currentState(path)?.doc);
onLspChange(() => {
  for (const path of files.keys()) reconfigureLsp(path);
});

function applyEntryDiagnostics(path: string): void {
  const state = currentState(path);
  if (!state) return;
  updateState(path, setDiagnostics(state, toDiagnostics(state.doc, locatedEntries(entries, path))));
}

/** Mounts the one EditorView into `parent`. Call once; returns an unmount function. */
export function mountEditor(parent: HTMLElement): () => void {
  view = new EditorView({ parent, state: emptyState() });
  if (activePath) {
    const record = files.get(activePath);
    if (record) view.setState(record.state);
  }
  return () => {
    if (view && activePath) {
      const record = files.get(activePath);
      if (record) record.state = view.state;
    }
    view?.destroy();
    view = null;
  };
}

export function setEntrySelectHandler(handler: (id: string) => void): void {
  onSelectEntry = handler;
}

/** What the "Show in PDF" command (Mod-Alt-J) does. */
export function setShowInPdfHandler(handler: () => void): void {
  onShowInPdf = handler;
}

/** Loads a file once from the server. Later calls reuse the in-memory state. */
export function loadFile(path: string): Promise<void> {
  if (files.has(path)) return Promise.resolve();
  let pending = loading.get(path);
  if (!pending) {
    pending = api
      .readFile(path)
      .then(({ content, mtimeMs }) => {
        const ref = { path };
        const state = createState(ref, content);
        files.set(path, { ref, state, savedDoc: state.doc, mtimeMs });
        applyEntryDiagnostics(path);
      })
      .finally(() => loading.delete(path));
    loading.set(path, pending);
  }
  return pending;
}

/** Loads `path` if needed and swaps it into the view; undo history stays per file. */
export async function openFile(path: string): Promise<void> {
  await loadFile(path);
  if (path === activePath) return;
  if (view && activePath) {
    const previous = files.get(activePath);
    if (previous) previous.state = view.state;
  }
  activePath = path;
  const record = files.get(path);
  if (view && record) {
    view.setState(record.state);
    view.focus();
  }
}

/** Forgets the in-memory state of a closed file. */
export function closeFile(path: string): void {
  if (path === activePath) {
    const record = files.get(path);
    if (view && record) record.state = view.state;
    activePath = null;
    view?.setState(emptyState());
  }
  files.delete(path);
  lspForget(path);
}

export function getDoc(path: string): string | undefined {
  return currentState(path)?.doc.toString();
}

export function isDirty(path: string): boolean {
  const state = currentState(path);
  const record = files.get(path);
  return !!state && !!record && !state.doc.eq(record.savedDoc);
}

export function getMtime(path: string): number | undefined {
  return files.get(path)?.mtimeMs;
}

/** Records that `doc` (a snapshot taken when the save started) is now on disk at `mtimeMs`. */
export function markSaved(path: string, doc: Text, mtimeMs: number): void {
  const record = files.get(path);
  if (!record) return;
  record.savedDoc = doc;
  record.mtimeMs = mtimeMs;
}

/** Snapshot of the current document, for saving. */
export function docSnapshot(path: string): Text | undefined {
  return currentState(path)?.doc;
}

/**
 * Applies changes to a file, loaded or not, as one undo step of its own (SPEC 3.5): it never
 * merges with the user's typing around it. Marks the file dirty.
 */
export async function applyChanges(path: string, changes: ChangeSpec): Promise<void> {
  await loadFile(path);
  updateState(path, {
    changes,
    annotations: isolateHistory.of('full'),
    userEvent: 'input.agent',
  });
}

// ---- Inline proposals (SPEC 3.1-3.5; see proposal.ts) ----------------------------------

/** The proposal shown in `path`, if any (the file must be loaded). */
export function inlineProposalOf(path: string): InlineProposal | null {
  const state = currentState(path);
  return state ? inlineProposal(state) : null;
}

/** Runs `update` on the state of a loaded file, reporting the proposal change if needed. */
function updateProposal(path: string, spec: TransactionSpec): void {
  const before = inlineProposalOf(path);
  updateState(path, spec);
  // Off-screen states have no update listener: report the change here.
  if (path !== activePath && inlineProposalOf(path) !== before) {
    for (const listener of proposalListeners) listener(path);
  }
}

/** Shows `proposal` in `path`, replacing any proposal shown there. */
export function showInlineProposal(path: string, proposal: InlineProposal): void {
  updateProposal(path, { effects: showProposal.of(proposal) });
}

/** Changes one hunk's decision or text. */
export function updateInlineHunk(
  path: string,
  index: number,
  change: { status?: 'pending' | 'accepted' | 'rejected'; newText?: string },
): void {
  updateProposal(path, { effects: updateHunk.of({ index, ...change }) });
}

export function clearInlineProposal(path: string): void {
  if (inlineProposalOf(path)) updateProposal(path, { effects: clearProposal.of(null) });
}

/**
 * Applies the accepted hunks and removes the proposal, as one undo step of its own (SPEC 3.5).
 * `changes` are in the current document's positions.
 */
export function applyInlineProposal(path: string, changes: ChangeSpec): void {
  updateProposal(path, {
    changes,
    effects: clearProposal.of(null),
    annotations: isolateHistory.of('full'),
    userEvent: 'input.agent',
  });
}

/** Called with the file's path whenever a proposal is shown, decided, moved or removed. */
export function onProposalChange(listener: (path: string) => void): () => void {
  proposalListeners.add(listener);
  return () => proposalListeners.delete(listener);
}

/** Replaces a file's content with what is on disk now, as one undoable change. */
export function replaceWithDisk(path: string, content: string, mtimeMs: number): void {
  const state = currentState(path);
  if (!state) return;
  updateState(path, { changes: { from: 0, to: state.doc.length, insert: content } });
  const after = currentState(path);
  if (after) markSaved(path, after.doc, mtimeMs);
}

/** Shows a build's entries as diagnostics in every loaded file. */
export function showEntries(next: readonly Entry[]): void {
  entries = next;
  for (const path of files.keys()) applyEntryDiagnostics(path);
}

/** Rings the margin reference of `id` in every loaded file (null clears it). */
export function highlightEntry(id: string | null): void {
  for (const path of files.keys()) {
    if (currentState(path)?.field(activeEntryField, false) !== id) {
      updateState(path, { effects: setActiveEntry.of(id) });
    }
  }
}

/** Scrolls the visible editor to a 1-based line and puts the cursor at its start. */
export function revealLine(line: number): void {
  if (!view) return;
  const doc = view.state.doc;
  const target = doc.line(Math.min(Math.max(line, 1), doc.lines));
  view.dispatch({
    selection: EditorSelection.cursor(target.from),
    effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
  });
  view.focus();
}

/** Called when the selection or cursor moves in the visible file. */
export function onSelectionChange(listener: () => void): () => void {
  selectionListeners.add(listener);
  return () => selectionListeners.delete(listener);
}

export interface CursorInfo {
  /** 1-based line of the cursor. */
  line: number;
  /** The selected text and the 1-based lines it spans, when something is selected. */
  selection?: { from: number; to: number; text: string };
}

/** Cursor and selection in the visible file, or null when no text file is shown. */
export function cursorInfo(): CursorInfo | null {
  if (!view || !activePath) return null;
  const { doc, selection } = view.state;
  const range = selection.main;
  const line = doc.lineAt(range.head).number;
  if (range.empty) return { line };
  // A selection of whole lines ends at the start of the next one, which it doesn't include.
  const last = doc.lineAt(range.to);
  return {
    line,
    selection: {
      from: doc.lineAt(range.from).number,
      to: last.from === range.to && last.number > 1 ? last.number - 1 : last.number,
      text: doc.sliceString(range.from, range.to),
    },
  };
}

/** Paths of every file loaded into the editor, open in a tab or not. */
export function loadedPaths(): string[] {
  return [...files.keys()];
}

export function onDocChange(listener: (path: string) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

const isUnder = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * Follows a rename of a file or folder: every loaded file at or under `from` keeps its state,
 * undo history and unsaved edits under its new path. Returns the renamed [old, new] pairs.
 */
export function renameLoaded(from: string, to: string): [string, string][] {
  const moved: [string, string][] = [];
  for (const [path, record] of [...files]) {
    if (!isUnder(path, from)) continue;
    const next = to + path.slice(from.length);
    files.delete(path);
    record.ref.path = next;
    files.set(next, record);
    moved.push([path, next]);
  }
  if (activePath && isUnder(activePath, from)) activePath = to + activePath.slice(from.length);
  for (const [old, next] of moved) {
    lspForget(old);
    reconfigureLsp(next);
  }
  return moved;
}

/** Forgets every loaded file at or under `path` (it was deleted); clears the view if shown. */
export function dropLoaded(path: string): void {
  if (activePath && isUnder(activePath, path)) {
    activePath = null;
    view?.setState(emptyState());
  }
  for (const loaded of [...files.keys()]) {
    if (!isUnder(loaded, path)) continue;
    files.delete(loaded);
    lspForget(loaded);
  }
}

/** Shows nothing in the editor (the active tab is a preview, or no tab is open). */
export function showNothing(): void {
  if (view && activePath) {
    const record = files.get(activePath);
    if (record) record.state = view.state;
  }
  activePath = null;
  view?.setState(emptyState());
}

/** Forgets every loaded file and shows nothing (another project was opened). */
export function closeAll(): void {
  activePath = null;
  entries = [];
  for (const path of files.keys()) lspForget(path);
  files.clear();
  view?.setState(emptyState());
}
