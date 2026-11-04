// Regenerates the <name>.log fixtures by compiling each <name>/ folder with latexmk.
// Run: bun apps/server/src/services/tests/__fixtures__/generate.ts

import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { compile } from '../../latex.ts';

const here = import.meta.dir;

for (const dirent of readdirSync(here, { withFileTypes: true })) {
  if (!dirent.isDirectory()) continue;
  const work = mkdtempSync(join(tmpdir(), `fixture-${dirent.name}-`));
  try {
    cpSync(join(here, dirent.name), work, { recursive: true });
    const run = await compile(work);
    // Logs can mention per-user font caches; keep home directories out of committed fixtures.
    await Bun.write(join(here, `${dirent.name}.log`), run.log.replaceAll(homedir(), '~'));
    console.log(`${dirent.name}: exit ${run.exitCode} in ${run.durationMs} ms`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
