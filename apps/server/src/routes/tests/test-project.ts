import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A frozen copy of the sample document: edits to sample-project/ don't change tests. */
export const SAMPLE_MAIN = join(import.meta.dir, '../../tests/__fixtures__/sample-main.tex');

/** Temp project holding the sample main.tex, for route tests. Call `remove` when done. */
export function tempProject(): { root: string; remove: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'route-test-'));
  cpSync(SAMPLE_MAIN, join(root, 'main.tex'));
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

export const BASE = 'http://127.0.0.1:3000';
