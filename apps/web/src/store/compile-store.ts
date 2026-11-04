import type { RootSource, SynctexBox } from '@phi/shared';
import { create } from 'zustand';

import type { Entry } from '../editor/entries.ts';

export type CompileStatus = 'idle' | 'compiling' | 'ok' | 'failed' | 'error';

interface CompileStore {
  /** The file a compile builds (SPEC 4.3), null until known; its PDF sits next to it. */
  root: string | null;
  rootSource: RootSource | null;
  /** Why no root could be chosen, e.g. a % !TEX root naming a missing file. */
  rootError: string | null;
  status: CompileStatus;
  /** Number of the last finished build (0 before the first). */
  build: number;
  durationMs: number | null;
  entries: Entry[];
  logTail: string;
  /** Request-level failure, e.g. latexmk missing. */
  error: string | null;
  /** Bumps after every build so the PDF viewer reloads. */
  pdfVersion: number;
  /** Build whose PDF the viewer shows (null before one has loaded). */
  pdfBuild: number | null;
  activeEntryId: string | null;
  /** New entries the user has already looked at. */
  visited: Record<string, true>;
  /** A box to scroll to and flash in the PDF ("Show in PDF", SPEC 6.4); nonce re-triggers. */
  pdfHighlight: { box: SynctexBox; nonce: number } | null;
  /** Why the last SyncTeX jump failed, shown briefly in the PDF pane. */
  syncError: string | null;
}

const INITIAL = {
  root: null,
  rootSource: null,
  rootError: null,
  status: 'idle',
  build: 0,
  durationMs: null,
  entries: [],
  logTail: '',
  error: null,
  pdfVersion: 0,
  pdfBuild: null,
  activeEntryId: null,
  visited: {},
  pdfHighlight: null,
  syncError: null,
} satisfies CompileStore;

export const useCompileStore = create<CompileStore>(() => INITIAL);

/** Another project opened: no build, no entries; the PDF viewer reloads. */
export function resetCompile(): void {
  useCompileStore.setState((s) => ({ ...INITIAL, pdfVersion: s.pdfVersion + 1 }));
}

export const countEntries = (entries: readonly Entry[]) => ({
  errors: entries.filter((e) => e.kind === 'error').length,
  warnings: entries.filter((e) => e.kind === 'warning').length,
});
