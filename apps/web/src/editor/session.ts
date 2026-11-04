// Editor workflows the components call: open, autosave, compile, jump to an entry,
// resolve a disk conflict. Components render stores; this module changes them.

import { fileKind, type CompileResult, type EditorSnapshot } from '@phi/shared';

import { api, ConflictError, ExistsError, RequestError } from '../api/client.ts';
import { resetCompile, useCompileStore } from '../store/compile-store.ts';
import {
  addOpenPath,
  remapOpenPaths,
  removeOpenPath,
  removeOpenPathsUnder,
  setSaveStatus,
  useEditorStore,
} from '../store/editor-store.ts';
import { numberEntries } from './entries.ts';
import { fitSnapshot } from './snapshot.ts';
import * as views from './views.ts';

export const AUTOSAVE_DELAY_MS = 1000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Map<string, Promise<void>>();

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function loadFileList(): Promise<void> {
  try {
    const files = await api.listFiles();
    useEditorStore.setState((s) => ({ files, filesError: null, filesVersion: s.filesVersion + 1 }));
  } catch (err) {
    useEditorStore.setState({ filesError: message(err) });
  }
}

const isText = (path: string) => fileKind(path) === 'text';

function syncSelection(): void {
  const hasSelection = !!views.cursorInfo()?.selection;
  if (useEditorStore.getState().hasSelection !== hasSelection) {
    useEditorStore.setState({ hasSelection });
  }
}

/** Opens a tab: text in the editor; images and PDFs as a preview (SPEC 4.2). */
export async function openFile(path: string): Promise<void> {
  try {
    if (isText(path)) await views.openFile(path);
    else views.showNothing();
    addOpenPath(path);
    if (isText(path)) void refreshRoot(path);
  } catch (err) {
    useEditorStore.setState({ saveError: `Could not open ${path}: ${message(err)}` });
  } finally {
    syncSelection();
  }
}

async function show(path: string | null): Promise<void> {
  if (path) await openFile(path);
  else views.showNothing();
  syncSelection();
}

/** Proposals the user reverted since the agent last heard about it (SPEC 3.6). */
let revertedToolCallIds: string[] = [];

export function noteRevert(toolCallId: string): void {
  if (!revertedToolCallIds.includes(toolCallId)) revertedToolCallIds.push(toolCallId);
}

/** The agent received these reverts with a message; stop repeating them. */
export function forgetReverts(sent: string[]): void {
  revertedToolCallIds = revertedToolCallIds.filter((id) => !sent.includes(id));
}

/** What the user sees now: active tab, cursor, selection and unsaved buffers (SPEC 5.7). */
export function buildSnapshot(): EditorSnapshot {
  return fitSnapshot({
    activeFile: useEditorStore.getState().activePath,
    cursor: views.cursorInfo(),
    dirty: views
      .loadedPaths()
      .filter(views.isDirty)
      .map((path) => ({ path, content: views.getDoc(path) ?? '' })),
    revertedToolCallIds,
  });
}

/** The selection in the visible file with its path, for "Ask about selection". */
export function currentSelection() {
  const path = useEditorStore.getState().activePath;
  const selection = views.cursorInfo()?.selection;
  return path && selection ? { path, ...selection } : null;
}

export async function closeFile(path: string): Promise<void> {
  if (isText(path) && views.isDirty(path)) await saveFile(path);
  const next = removeOpenPath(path);
  views.closeFile(path);
  await show(next);
}

/** Looks up the root a compile would build for `activeFile` (SPEC 4.3), for the tree and PDF. */
export async function refreshRoot(
  activeFile = useEditorStore.getState().activePath,
): Promise<void> {
  try {
    const { root, source } = await api.root(
      activeFile && isText(activeFile) ? activeFile : undefined,
    );
    useCompileStore.setState({ root, rootSource: source, rootError: null });
  } catch (err) {
    useCompileStore.setState({ root: null, rootSource: null, rootError: message(err) });
  }
}

/** Writes a file now if it has unsaved changes. Never overwrites a newer file on disk. */
export async function saveFile(path: string): Promise<void> {
  clearTimeout(timers.get(path));
  timers.delete(path);
  await inFlight.get(path);
  if (!views.isDirty(path) || useEditorStore.getState().conflict?.path === path) return;

  const doc = views.docSnapshot(path);
  const baseMtimeMs = views.getMtime(path);
  if (!doc) return;
  setSaveStatus(path, 'saving');

  const write = api
    .writeFile(path, { content: doc.toString(), baseMtimeMs })
    .then(({ mtimeMs }) => {
      views.markSaved(path, doc, mtimeMs);
      setSaveStatus(path, views.isDirty(path) ? 'unsaved' : 'saved');
      useEditorStore.setState({ saveError: null });
    })
    .catch((err: unknown) => {
      if (err instanceof ConflictError) {
        setSaveStatus(path, 'conflict');
        useEditorStore.setState({ conflict: { path, mtimeMs: err.conflict.mtimeMs } });
      } else {
        setSaveStatus(path, 'error');
        useEditorStore.setState({ saveError: `Could not save ${path}: ${message(err)}` });
      }
    })
    .finally(() => inFlight.delete(path));
  inFlight.set(path, write);
  await write;
  // Typing during the request leaves newer edits; queue them.
  if (views.isDirty(path)) scheduleSave(path);
}

function scheduleSave(path: string): void {
  clearTimeout(timers.get(path));
  timers.set(
    path,
    setTimeout(() => void saveFile(path), AUTOSAVE_DELAY_MS),
  );
}

/** Saves every file with pending edits, right away. */
export async function saveAll(): Promise<void> {
  const { openPaths } = useEditorStore.getState();
  await Promise.all(openPaths.filter(views.isDirty).map(saveFile));
}

/** Resolves a 409: reload the disk version, or overwrite it with the editor's text. */
export async function resolveConflict(choice: 'reload' | 'overwrite'): Promise<void> {
  const conflict = useEditorStore.getState().conflict;
  if (!conflict) return;
  const { path } = conflict;
  try {
    if (choice === 'reload') {
      const { content, mtimeMs } = await api.readFile(path);
      views.replaceWithDisk(path, content, mtimeMs);
    } else {
      const doc = views.docSnapshot(path);
      if (!doc) return;
      const { mtimeMs } = await api.writeFile(path, { content: doc.toString() });
      views.markSaved(path, doc, mtimeMs);
    }
    useEditorStore.setState({ conflict: null, saveError: null });
    setSaveStatus(path, views.isDirty(path) ? 'unsaved' : 'saved');
  } catch (err) {
    useEditorStore.setState({ saveError: `Could not ${choice} ${path}: ${message(err)}` });
  }
}

/** Shows a build, whoever ran it (the user or the agent): entries, status and the PDF. */
export function showCompileResult(result: CompileResult): void {
  const previous = useCompileStore.getState();
  const entries = numberEntries(result, previous.build > 0 ? previous.entries : null);
  views.showEntries(entries);
  views.highlightEntry(null);
  useCompileStore.setState({
    root: result.root,
    rootError: null,
    status: result.ok ? 'ok' : 'failed',
    error: null,
    build: previous.build + 1,
    durationMs: result.durationMs,
    entries,
    logTail: result.logTail,
    pdfVersion: previous.pdfVersion + 1,
    activeEntryId: null,
    visited: {},
  });
}

/** Saves pending edits, then compiles and shows the result. */
export async function compile(): Promise<void> {
  if (useCompileStore.getState().status === 'compiling') return;
  useCompileStore.setState({ status: 'compiling', error: null });
  await saveAll();
  try {
    const active = useEditorStore.getState().activePath;
    showCompileResult(
      await api.compile({ activeFile: active && isText(active) ? active : undefined }),
    );
  } catch (err) {
    const rootProblem = err instanceof RequestError && err.status === 400;
    useCompileStore.setState({
      status: 'error',
      error: message(err),
      ...(rootProblem ? { rootError: message(err) } : {}),
    });
  }
}

const SYNC_ERROR_MS = 4000;

function showSyncError(error: unknown): void {
  useCompileStore.setState({ syncError: message(error) });
  setTimeout(() => useCompileStore.setState({ syncError: null }), SYNC_ERROR_MS);
}

/** "Show in PDF" (SPEC 6.4): scrolls the PDF to the cursor's line and flashes it. */
export async function showInPdf(): Promise<void> {
  const path = useEditorStore.getState().activePath;
  const cursor = views.cursorInfo();
  if (!path || !cursor || !isText(path)) return;
  try {
    const box = await api.synctexView(path, cursor.line);
    useCompileStore.setState((s) => ({
      pdfHighlight: { box, nonce: (s.pdfHighlight?.nonce ?? 0) + 1 },
      syncError: null,
    }));
  } catch (err) {
    showSyncError(err);
  }
}

/** Cmd/Ctrl+click in the PDF (SPEC 6.4): opens the source file at the line typeset there. */
export async function goToSource(pdf: string, page: number, x: number, y: number): Promise<void> {
  try {
    const { file, line } = await api.synctexEdit(pdf, page, x, y);
    await openFile(file);
    views.revealLine(line);
  } catch (err) {
    showSyncError(err);
  }
}

/** Opens an entry's file at its line and rings it in the margin and the list. */
export async function selectEntry(id: string): Promise<void> {
  const entry = useCompileStore.getState().entries.find((e) => e.id === id);
  if (!entry) return;
  useCompileStore.setState((s) => ({ activeEntryId: id, visited: { ...s.visited, [id]: true } }));
  views.highlightEntry(id);
  const inProject = useEditorStore.getState().files.some((f) => f.path === entry.file);
  if (entry.line === null || !inProject) return;
  await openFile(entry.file);
  views.revealLine(entry.line);
}

/** Wires editor changes to autosave, margin clicks to entries, and ⌘S / Ctrl+S. */
export function startSession(): () => void {
  views.setEntrySelectHandler((id) => void selectEntry(id));
  views.setShowInPdfHandler(() => void showInPdf());
  const offChange = views.onDocChange((path) => {
    useEditorStore.setState((s) => ({ docVersion: s.docVersion + 1 }));
    if (useEditorStore.getState().conflict?.path === path) return;
    setSaveStatus(path, 'unsaved');
    scheduleSave(path);
  });
  const offSelection = views.onSelectionChange(syncSelection);
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void compile();
    }
  };
  window.addEventListener('keydown', onKey);
  return () => {
    offChange();
    offSelection();
    window.removeEventListener('keydown', onKey);
  };
}

// ---- File operations (SPEC 4.1, 4.2) -------------------------------------------------------

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const isUnder = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

function reportFileError(err: unknown): void {
  useEditorStore.setState({ fileError: message(err) });
}

function cancelSavesUnder(path: string): void {
  for (const [pending, timer] of timers) {
    if (isUnder(pending, path)) {
      clearTimeout(timer);
      timers.delete(pending);
    }
  }
}

/**
 * Before another project opens (SPEC 4.4): saves what is unsaved, then forgets every file,
 * tab, build and revert of this one.
 */
export async function resetWorkspace(): Promise<void> {
  // Every loaded buffer, open in a tab or not (an accepted agent edit may have no tab).
  await Promise.all(views.loadedPaths().filter(views.isDirty).map(saveFile));
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  revertedToolCallIds = [];
  views.closeAll();
  useEditorStore.setState((s) => ({
    files: [],
    filesVersion: s.filesVersion + 1,
    filesError: null,
    openPaths: [],
    activePath: null,
    saveStatus: {},
    saveError: null,
    fileError: null,
    conflict: null,
    hasSelection: false,
  }));
  resetCompile();
}

/** After a rename on disk (by the user or an accepted proposal): tabs and buffers follow it. */
export async function followRename(from: string, to: string): Promise<void> {
  cancelSavesUnder(from);
  views.renameLoaded(from, to);
  remapOpenPaths(from, to);
  useEditorStore.setState({ fileError: null });
  await loadFileList();
  const active = useEditorStore.getState().activePath;
  if (active && !isText(active)) views.showNothing();
  void refreshRoot();
}

/** After a delete on disk: closes its tabs and forgets its buffers. */
export async function followDelete(path: string): Promise<void> {
  cancelSavesUnder(path);
  views.dropLoaded(path);
  const next = removeOpenPathsUnder(path);
  await show(next);
  useEditorStore.setState({ fileError: null });
  await loadFileList();
  void refreshRoot();
}

/** Creates a file (and opens it) or a folder inside `dir`. Returns false on failure. */
export async function createEntry(
  dir: string,
  name: string,
  type: 'file' | 'dir',
): Promise<boolean> {
  const path = join(dir, name.trim());
  try {
    await api.create(type === 'dir' ? { path, type } : { path, type, content: '' });
    useEditorStore.setState({ fileError: null });
    await loadFileList();
    if (type === 'file') await openFile(path);
    return true;
  } catch (err) {
    reportFileError(err instanceof ExistsError ? new Error(`${path} already exists.`) : err);
    return false;
  }
}

/**
 * Renames or moves a file or folder. Unsaved edits under it are saved first; open tabs and
 * their editor state (undo history included) follow the new path.
 */
export async function renameEntry(from: string, to: string): Promise<boolean> {
  if (from === to) return true;
  try {
    const { openPaths } = useEditorStore.getState();
    await Promise.all(openPaths.filter((p) => isUnder(p, from) && isText(p)).map(saveFile));
    cancelSavesUnder(from);
    await api.rename({ from, to });
    await followRename(from, to);
    return true;
  } catch (err) {
    reportFileError(err instanceof ExistsError ? new Error(`${to} already exists.`) : err);
    return false;
  }
}

/** Moves a file or folder to the trash; its tabs close and their editor state is dropped. */
export async function deleteEntry(path: string): Promise<boolean> {
  try {
    cancelSavesUnder(path);
    await api.remove(path);
    await followDelete(path);
    return true;
  } catch (err) {
    reportFileError(err);
    return false;
  }
}

export interface UploadOutcome {
  uploaded: string[];
  /** Files whose name is taken; the caller may retry them with replace. */
  existing: File[];
}

/** Uploads dropped files into `dir` (SPEC 4.2). Name clashes are returned, not overwritten. */
export async function uploadFiles(
  dir: string,
  files: File[],
  replace = false,
): Promise<UploadOutcome> {
  const outcome: UploadOutcome = { uploaded: [], existing: [] };
  const problems: string[] = [];
  for (const file of files) {
    const path = join(dir, file.name);
    try {
      await api.upload(path, file, replace);
      outcome.uploaded.push(path);
    } catch (err) {
      if (err instanceof ExistsError) outcome.existing.push(file);
      else problems.push(`${file.name}: ${message(err)}`);
    }
  }
  useEditorStore.setState({ fileError: problems.length ? problems.join('\n') : null });
  if (outcome.uploaded.length) await loadFileList();
  return outcome;
}
