import type { CompileError, CompileResult } from '@phi/shared';

/** A numbered compile problem: E1, E2… for errors, W1, W2… for warnings. */
export interface Entry extends CompileError {
  id: string;
  kind: 'error' | 'warning';
  /** Not present in the previous build (compared without line numbers, which shift with edits). */
  isNew: boolean;
}

const key = (kind: Entry['kind'], e: CompileError) => `${kind}\0${e.file}\0${e.message}`;

/**
 * Numbers a build's errors and warnings and marks those the previous build did not have.
 * `previous` is null before the first build, when nothing counts as new.
 */
export function numberEntries(
  result: CompileResult,
  previous: readonly Entry[] | null = null,
): Entry[] {
  const seen = new Set(previous?.map((e) => key(e.kind, e)));
  const number = (kind: Entry['kind'], prefix: string) => (e: CompileError, i: number) => ({
    ...e,
    id: `${prefix}${i + 1}`,
    kind,
    isNew: previous !== null && !seen.has(key(kind, e)),
  });
  return [
    ...result.errors.map(number('error', 'E')),
    ...result.warnings.map(number('warning', 'W')),
  ];
}

/** Entries that point at a line in a project file, so they can be shown in the editor. */
export function locatedEntries(entries: readonly Entry[], path: string): Entry[] {
  return entries.filter((e) => e.file === path && e.line !== null);
}
