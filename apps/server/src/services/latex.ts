import { basename, dirname, join } from 'node:path';

import { resolveInProject } from './paths.ts';

const TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 2_000;

const LATEXMK_FLAGS = [
  '-pdf',
  '-interaction=nonstopmode',
  '-file-line-error',
  '-synctex=1',
  '-no-shell-escape',
  // A project latexmkrc is Perl; reading it would let project files run arbitrary code.
  '-norc',
];

/**
 * Where TeX distributions put their binaries. Processes started before the install (an open
 * terminal or editor) don't have these on PATH yet; macOS adds them only to new login shells.
 */
export const TEX_BIN_DIRS = ['/Library/TeX/texbin'];

/**
 * Finds a TeX binary on PATH, else in a known TeX bin folder. Returns it and the PATH to run it
 * with (the fallback folder appended, so it can find its sibling tools), or null.
 */
export function findTexBinary(
  name: string,
  path: string = process.env.PATH ?? '',
  fallbacks: readonly string[] = TEX_BIN_DIRS,
): { binary: string; path: string } | null {
  const onPath = Bun.which(name, { PATH: path });
  if (onPath) return { binary: onPath, path };
  for (const dir of fallbacks) {
    const binary = Bun.which(name, { PATH: dir });
    if (binary) return { binary, path: path ? `${path}:${dir}` : dir };
  }
  return null;
}

/** latexmk, as findTexBinary finds it. */
export function findLatexmk(
  path: string = process.env.PATH ?? '',
  fallbacks: readonly string[] = TEX_BIN_DIRS,
): { latexmk: string; path: string } | null {
  const found = findTexBinary('latexmk', path, fallbacks);
  return found ? { latexmk: found.binary, path: found.path } : null;
}

export interface CompileRun {
  /** Contents of <main>.log, or latexmk's own output if no log was written. */
  log: string;
  /** latexmk's stdout and stderr. */
  output: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Runs latexmk on `main` (project-relative) from its own directory. Throws if latexmk is
 * missing or `signal` aborts; a timeout returns normally with `timedOut: true`.
 */
export async function compile(
  root: string,
  main = 'main.tex',
  signal?: AbortSignal,
): Promise<CompileRun> {
  const tex = findLatexmk();
  if (!tex) {
    throw new Error(
      'latexmk is not installed or not on PATH. Install a TeX distribution ' +
        '(e.g. `brew install --cask basictex`, then `sudo tlmgr install latexmk`).',
    );
  }
  const mainPath = resolveInProject(root, main);
  if (!(await Bun.file(mainPath).exists())) throw new Error(`Main file not found: ${main}`);
  signal?.throwIfAborted();

  const cwd = dirname(mainPath);
  const file = basename(mainPath);
  const started = performance.now();
  const proc = Bun.spawn([tex.latexmk, ...LATEXMK_FLAGS, file], {
    cwd,
    // Own process group, so killing it also stops the pdflatex/bibtex children.
    detached: true,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    // Stops TeX from hard-wrapping log lines at 79 chars, which breaks parsing.
    // PATH must also reach pdflatex/bibtex, which latexmk runs.
    env: { ...process.env, PATH: tex.path, max_print_line: '10000' },
  });

  let timedOut = false;
  const kill = () => killGroup(proc.pid);
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, TIMEOUT_MS);
  signal?.addEventListener('abort', kill, { once: true });

  let stdout: string, stderr: string, exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', kill);
  }
  signal?.throwIfAborted();

  const output = stdout + stderr;
  const logFile = Bun.file(join(cwd, file.replace(/\.tex$/, '') + '.log'));
  return {
    log: (await logFile.exists()) ? await logFile.text() : output,
    output,
    exitCode,
    durationMs: Math.round(performance.now() - started),
    timedOut,
  };
}

function killGroup(pid: number): void {
  const signalGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      // Group already gone.
    }
  };
  signalGroup('SIGTERM');
  setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS).unref();
}
