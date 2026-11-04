import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';

import type { CompileError, CompileResult } from '@phi/shared';

import { compile } from './latex.ts';
import { parseLatexLog } from './log-parser.ts';
import { resolveInProject } from './paths.ts';

const running = new Map<string, Promise<CompileResult>>();
/** The most recent result per project, whoever compiled (the user or the agent). */
const latest = new Map<string, CompileResult>();

/**
 * LaTeX reports paths relative to the folder it ran in (the root's folder). Rebase them onto
 * the project so thesis/thesis.tex's "chapters/a.tex" becomes "thesis/chapters/a.tex".
 */
function projectRelative(rootFile: string, errors: CompileError[]): CompileError[] {
  const dir = posix.dirname(rootFile);
  if (dir === '.') return errors;
  return errors.map((e) =>
    e.file && !posix.isAbsolute(e.file) ? { ...e, file: posix.join(dir, e.file) } : e,
  );
}

async function runCompile(root: string, rootFile: string): Promise<CompileResult> {
  const run = await compile(root, rootFile);
  const { errors, warnings, tail } = parseLatexLog(run.log);
  if (run.timedOut) {
    errors.push({ file: '', line: null, message: 'Compilation timed out after 60 s' });
  }
  const result: CompileResult = {
    root: rootFile,
    ok: run.exitCode === 0 && !run.timedOut,
    durationMs: run.durationMs,
    errors: projectRelative(rootFile, errors),
    warnings: projectRelative(rootFile, warnings),
    logTail: tail,
  };
  latest.set(root, result);
  return result;
}

/** The last finished compile of the project at `root`, if any since the server started. */
export function lastCompile(root: string): CompileResult | undefined {
  return latest.get(root);
}

/**
 * Project files the last compile of `rootFile` read, from the .fls file latexmk records
 * next to it ([] before the first compile). Paths are project-relative.
 */
export async function compiledInputs(root: string, rootFile: string): Promise<string[]> {
  const rootPath = resolveInProject(root, rootFile);
  const fls = Bun.file(rootPath.replace(/\.tex$/i, '') + '.fls');
  if (!(await fls.exists())) return [];
  const inputs = new Set<string>();
  for (const line of (await fls.text()).split(/\r?\n/)) {
    if (!line.startsWith('INPUT ')) continue;
    const rel = relative(root, resolve(dirname(rootPath), line.slice('INPUT '.length)));
    if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      inputs.add(rel.split(sep).join('/'));
    }
  }
  return [...inputs];
}

/**
 * Compiles `rootFile` (project-relative) in its own folder, one compile per root at a time:
 * a caller arriving while it compiles gets that compile's result. Aborting `signal` stops this
 * caller waiting; the shared compile carries on for the others.
 */
export function compileProject(
  root: string,
  rootFile: string,
  signal?: AbortSignal,
): Promise<CompileResult> {
  const key = `${root}\0${rootFile}`;
  let shared = running.get(key);
  if (!shared) {
    shared = runCompile(root, rootFile).finally(() => running.delete(key));
    running.set(key, shared);
  }
  if (!signal) return shared;

  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
