import { posix } from 'node:path';

import type { RootSource } from '@phi/shared';

import { listFiles, readText } from './fs.ts';
import { APP_DATA_DIR, PathError, resolveInProject } from './paths.ts';

export const SETTINGS_PATH = `${APP_DATA_DIR}/settings.json`;
const MAGIC_LINES = 5;
/** `% !TEX root = ../main.tex` (TeXShop / VS Code LaTeX Workshop style; case-insensitive). */
const MAGIC = /^\s*%\s*!\s*tex\s+root\s*=\s*(.+?)\s*$/i;
/** A \documentclass that is not commented out on its line. */
const DOCUMENTCLASS = /^[^%\n]*\\documentclass\b/m;

/** Whether `content` is a root document: it has an uncommented \documentclass. */
export const hasDocumentClass = (content: string) => DOCUMENTCLASS.test(content);

export interface ResolvedRoot {
  root: string;
  source: RootSource;
}

/** No root could be chosen, or one that was named explicitly doesn't exist. */
export class RootError extends Error {
  override name = 'RootError';
}

async function isFile(root: string, path: string): Promise<boolean> {
  try {
    const file = Bun.file(resolveInProject(root, path));
    return (await file.exists()) && (await file.stat()).isFile();
  } catch {
    return false;
  }
}

/** The root named by a magic comment in the first 5 lines of `activeFile`, if any. */
async function magicRoot(root: string, activeFile: string): Promise<string | null> {
  const { content } = await readText(root, activeFile);
  const line = content.split(/\r?\n/, MAGIC_LINES).find((l) => MAGIC.test(l));
  if (!line) return null;
  const value = MAGIC.exec(line)?.[1]?.replace(/^["']|["']$/g, '') ?? '';

  // Relative to the active file's folder; may climb with "..", but must stay in the project.
  const joined = posix.normalize(posix.join(posix.dirname(activeFile), value));
  if (posix.isAbsolute(value) || joined === '..' || joined.startsWith('../')) {
    throw new RootError(`The "% !TEX root" in ${activeFile} points outside the project: ${value}`);
  }
  for (const candidate of posix.extname(joined) ? [joined] : [joined, `${joined}.tex`]) {
    if (await isFile(root, candidate)) return candidate;
  }
  throw new RootError(
    `The "% !TEX root" in ${activeFile} names ${value}, but ${joined} doesn't exist.`,
  );
}

/** `rootFile` from .latex-agent/settings.json, if set. */
async function settingsRoot(root: string): Promise<string | null> {
  const file = Bun.file(resolveInProject(root, SETTINGS_PATH, { allowAppData: true }));
  if (!(await file.exists())) return null;
  let settings: unknown;
  try {
    settings = await file.json();
  } catch {
    throw new RootError(`${SETTINGS_PATH} is not valid JSON.`);
  }
  const rootFile = (settings as { rootFile?: unknown } | null)?.rootFile;
  if (rootFile === undefined || rootFile === null || rootFile === '') return null;
  if (typeof rootFile !== 'string')
    throw new RootError(`"rootFile" in ${SETTINGS_PATH} must be a path.`);
  const path = posix.normalize(rootFile);
  if (!(await isFile(root, path))) {
    throw new RootError(`"rootFile" in ${SETTINGS_PATH} is ${rootFile}, which doesn't exist.`);
  }
  return path;
}

/** Every .tex file with an uncommented \documentclass, in path order. */
async function documentClassFiles(root: string): Promise<string[]> {
  const tex = (await listFiles(root)).filter(
    (e) => !e.isDir && e.path.toLowerCase().endsWith('.tex'),
  );
  const found: string[] = [];
  for (const { path } of tex) {
    const { content } = await readText(root, path);
    if (hasDocumentClass(content)) found.push(path);
  }
  return found;
}

/**
 * The file to compile, following SPEC 4.3 in order: a `% !TEX root = …` comment in the first
 * 5 lines of the active file (relative to its folder); `rootFile` in .latex-agent/settings.json;
 * the only .tex file containing \documentclass; main.tex. Throws a RootError when none applies,
 * or when an explicitly named root doesn't exist.
 */
export async function resolveRoot(root: string, activeFile?: string): Promise<ResolvedRoot> {
  if (activeFile) {
    try {
      resolveInProject(root, activeFile);
    } catch (err) {
      if (err instanceof PathError) throw new RootError(err.message);
      throw err;
    }
    if (await isFile(root, activeFile)) {
      const magic = await magicRoot(root, activeFile);
      if (magic) return { root: magic, source: 'magic-comment' };
    }
  }

  const fromSettings = await settingsRoot(root);
  if (fromSettings) return { root: fromSettings, source: 'settings' };

  const candidates = await documentClassFiles(root);
  if (candidates.length === 1) return { root: candidates[0]!, source: 'documentclass' };

  if (await isFile(root, 'main.tex')) return { root: 'main.tex', source: 'main.tex' };

  if (candidates.length > 1) {
    throw new RootError(
      `Several files have \\documentclass (${candidates.join(', ')}) and there is no main.tex. ` +
        `Add "% !TEX root = <file>" to the file you are editing, or set "rootFile" in ${SETTINGS_PATH}.`,
    );
  }
  throw new RootError(
    'No file to compile: no .tex file has \\documentclass and there is no main.tex.',
  );
}
