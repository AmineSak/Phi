import type { FileEntry } from '@phi/shared';
import { create } from 'zustand';

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'conflict' | 'error';

export interface Conflict {
  path: string;
  /** Disk mtime the server reported, or null when the file was deleted. */
  mtimeMs: number | null;
}

interface EditorStore {
  files: FileEntry[];
  /** Bumps whenever the file list reloads, so previews refetch replaced files. */
  filesVersion: number;
  filesError: string | null;
  openPaths: string[];
  activePath: string | null;
  /** Per-path save status; absent means saved. */
  saveStatus: Record<string, SaveStatus>;
  saveError: string | null;
  /** The last create, rename, delete or upload problem, shown in the file tree. */
  fileError: string | null;
  conflict: Conflict | null;
  /** Text is selected in the visible file ("Ask about selection" is offered). */
  hasSelection: boolean;
  /** Bumps on every document change in any loaded file, for views that depend on text. */
  docVersion: number;
}

export const useEditorStore = create<EditorStore>(() => ({
  files: [],
  filesVersion: 0,
  filesError: null,
  openPaths: [],
  activePath: null,
  saveStatus: {},
  saveError: null,
  fileError: null,
  conflict: null,
  hasSelection: false,
  docVersion: 0,
}));

export function setSaveStatus(path: string, status: SaveStatus): void {
  useEditorStore.setState((s) => ({ saveStatus: { ...s.saveStatus, [path]: status } }));
}

export function addOpenPath(path: string): void {
  useEditorStore.setState((s) => ({
    activePath: path,
    openPaths: s.openPaths.includes(path) ? s.openPaths : [...s.openPaths, path],
  }));
}

/** Removes a tab; activates its neighbour when it was the active one. */
export function removeOpenPath(path: string): string | null {
  const { openPaths, activePath } = useEditorStore.getState();
  const index = openPaths.indexOf(path);
  const rest = openPaths.filter((p) => p !== path);
  const nextActive =
    activePath === path ? (rest[Math.min(index, rest.length - 1)] ?? null) : activePath;
  useEditorStore.setState({ openPaths: rest, activePath: nextActive });
  return nextActive;
}

const isUnder = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

const remap = (path: string, from: string, to: string) =>
  isUnder(path, from) ? to + path.slice(from.length) : path;

/** After a rename of a file or folder: tabs, the active tab and save status follow it. */
export function remapOpenPaths(from: string, to: string): void {
  useEditorStore.setState((s) => ({
    openPaths: s.openPaths.map((p) => remap(p, from, to)),
    activePath: s.activePath === null ? null : remap(s.activePath, from, to),
    saveStatus: Object.fromEntries(
      Object.entries(s.saveStatus).map(([p, status]) => [remap(p, from, to), status]),
    ),
    conflict: s.conflict ? { ...s.conflict, path: remap(s.conflict.path, from, to) } : null,
  }));
}

/** After a delete: closes every tab at or under `path`; returns the tab to show next. */
export function removeOpenPathsUnder(path: string): string | null {
  const { openPaths, activePath } = useEditorStore.getState();
  const kept = openPaths.filter((p) => !isUnder(p, path));
  const activeGone = activePath !== null && isUnder(activePath, path);
  const next = activeGone ? (kept.at(-1) ?? null) : activePath;
  useEditorStore.setState((s) => ({
    openPaths: kept,
    activePath: next,
    saveStatus: Object.fromEntries(Object.entries(s.saveStatus).filter(([p]) => !isUnder(p, path))),
    conflict: s.conflict && isUnder(s.conflict.path, path) ? null : s.conflict,
  }));
  return next;
}
