import type { EditorSnapshot } from '@phi/shared';

import { readText } from '../services/fs.ts';
import { resolveInProject } from '../services/paths.ts';

/** A thread's view of the project: files on disk, overlaid with the editor's unsaved buffers. */
export interface Workspace {
  /** The latest snapshot from the editor, or null before the first one. */
  readonly snapshot: EditorSnapshot | null;
  /** Replaces the snapshot; throws a PathError if it names a path outside the project. */
  setSnapshot(snapshot: EditorSnapshot): void;
  /** The text the user sees: the unsaved buffer if the editor has one, else the disk content. */
  readText(path: string): Promise<string>;
}

export function createWorkspace(root: string): Workspace {
  let snapshot: EditorSnapshot | null = null;

  // Compare resolved paths, so "./a.tex" and "a.tex" are the same file.
  const dirtyBuffer = (path: string) => {
    const target = resolveInProject(root, path);
    return snapshot?.dirtyFiles.find((f) => resolveInProject(root, f.path) === target);
  };

  return {
    get snapshot() {
      return snapshot;
    },
    setSnapshot(next) {
      if (next.activeFile) resolveInProject(root, next.activeFile);
      for (const file of next.dirtyFiles) resolveInProject(root, file.path);
      snapshot = next;
    },
    async readText(path) {
      return dirtyBuffer(path)?.content ?? (await readText(root, path)).content;
    },
  };
}
