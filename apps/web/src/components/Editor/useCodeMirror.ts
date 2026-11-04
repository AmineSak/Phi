import { useEffect, useRef } from 'react';

import { fileKind } from '@phi/shared';

import { mountEditor, openFile } from '../../editor/views.ts';

/**
 * Mounts the single EditorView into the returned ref once, and swaps in the active file's
 * state when it changes. CodeMirror stays uncontrolled: React never passes it a document.
 */
export function useCodeMirror(activePath: string | null) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    return mountEditor(ref.current);
  }, []);

  useEffect(() => {
    // Images and PDFs are previewed, never loaded into CodeMirror.
    if (activePath && fileKind(activePath) === 'text') void openFile(activePath);
  }, [activePath]);

  return ref;
}
