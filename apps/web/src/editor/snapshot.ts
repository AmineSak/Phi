// Fits what the editor shows into an EditorSnapshot within the server's limits (SPEC 5.7).

import {
  MAX_SELECTION_CHARS,
  MAX_SNAPSHOT_DIRTY_BYTES,
  MAX_SNAPSHOT_DIRTY_FILES,
  type EditorSnapshot,
} from '@phi/shared';

export interface EditorShown {
  activeFile: string | null;
  cursor: { line: number; selection?: { from: number; to: number; text: string } } | null;
  /** Files with unsaved edits, in any order. */
  dirty: { path: string; content: string }[];
  /** Proposals the user reverted since the last message (SPEC 3.6). */
  revertedToolCallIds?: string[];
}

const encoder = new TextEncoder();

/**
 * Builds the snapshot: the active file's buffer first, then the others while they fit in
 * 5 files and 200 KB; a buffer too big to fit is left out (the agent then reads the disk).
 */
export function fitSnapshot({
  activeFile,
  cursor,
  dirty,
  revertedToolCallIds = [],
}: EditorShown): EditorSnapshot {
  const ordered = [
    ...dirty.filter((f) => f.path === activeFile),
    ...dirty.filter((f) => f.path !== activeFile),
  ];
  const dirtyFiles: EditorSnapshot['dirtyFiles'] = [];
  let bytes = 0;
  for (const file of ordered) {
    if (dirtyFiles.length === MAX_SNAPSHOT_DIRTY_FILES) break;
    const size = encoder.encode(file.content).length;
    if (bytes + size > MAX_SNAPSHOT_DIRTY_BYTES) continue;
    bytes += size;
    dirtyFiles.push(file);
  }
  const selection = cursor?.selection;
  return {
    activeFile,
    cursorLine: cursor?.line ?? null,
    ...(selection
      ? { selection: { ...selection, text: selection.text.slice(0, MAX_SELECTION_CHARS) } }
      : {}),
    dirtyFiles,
    revertedToolCallIds: [...revertedToolCallIds],
  };
}
