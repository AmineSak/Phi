import {
  rename as fsRename,
  lstat,
  mkdir,
  readdir,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { fileKind, type FileEntry } from '@phi/shared';

import { APP_DATA_DIR, isAppDataPath, PathError, resolveInProject } from './paths.ts';
import { checkUpload } from './upload.ts';

const SKIPPED_DIRS = new Set(['.git', 'node_modules']);
const BUILD_ARTIFACTS = [
  '.aux',
  '.log',
  '.fls',
  '.fdb_latexmk',
  '.synctex.gz',
  '.out',
  '.toc',
  '.bbl',
  '.blg',
];

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

export class ConflictError extends Error {
  override name = 'ConflictError';
  constructor(
    readonly path: string,
    /** mtime of the file on disk, or null if it was deleted. */
    readonly mtimeMs: number | null,
  ) {
    super(`${path} changed on disk since it was read`);
  }
}

/** An item already exists where a new one would go (create, rename target, upload). */
export class ExistsError extends Error {
  override name = 'ExistsError';
  constructor(readonly path: string) {
    super(`${path} already exists`);
  }
}

/**
 * Every file and directory under root, as sorted project-relative paths, with each file's
 * kind. Hides .git, node_modules, LaTeX build artifacts and .latex-agent (SPEC 4.5). Folders
 * that can't be read are listed without their contents.
 */
export async function listFiles(root: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  async function walk(relDir: string): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(join(root, relDir), { withFileTypes: true });
    } catch (err) {
      // A folder the OS won't let us read (macOS-protected, another user's) is listed but left
      // closed; failing the whole listing would leave the file tree empty.
      const code = (err as NodeJS.ErrnoException).code;
      if (relDir && (code === 'EPERM' || code === 'EACCES')) return;
      throw err;
    }
    for (const dirent of dirents) {
      const path = relDir ? `${relDir}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (SKIPPED_DIRS.has(dirent.name) || isAppDataPath(path)) continue;
        entries.push({ path, isDir: true });
        await walk(path);
      } else if (!BUILD_ARTIFACTS.some((ext) => dirent.name.endsWith(ext))) {
        if (isAppDataPath(path)) continue;
        // Symlinks are listed as files and never followed; reads go through resolveInProject.
        entries.push({ path, isDir: false, kind: fileKind(path) });
      }
    }
  }

  await walk('');
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function readText(
  root: string,
  path: string,
): Promise<{ content: string; mtimeMs: number }> {
  const absolute = resolveInProject(root, path);
  const info = await stat(absolute).catch((err: NodeJS.ErrnoException) => {
    // Name the project-relative path, never the absolute one; keep the code for HTTP mapping.
    if (err.code === 'ENOENT')
      throw Object.assign(new Error(`File not found: ${path}`), { code: 'ENOENT' });
    throw err;
  });
  if (info.isDirectory()) {
    throw Object.assign(new Error(`${path} is a directory, not a file`), { code: 'EISDIR' });
  }
  return { content: await Bun.file(absolute).text(), mtimeMs: info.mtimeMs };
}

/**
 * Writes a file, creating parent dirs. With `baseMtimeMs`, throws a ConflictError
 * instead of overwriting if the file changed (or vanished) since that read.
 */
export async function writeText(
  root: string,
  path: string,
  content: string,
  baseMtimeMs?: number,
): Promise<{ mtimeMs: number }> {
  const absolute = resolveInProject(root, path);
  return withFileLock(absolute, async () => {
    const before = await stat(absolute).catch(() => null);
    if (baseMtimeMs !== undefined && before?.mtimeMs !== baseMtimeMs) {
      throw new ConflictError(path, before?.mtimeMs ?? null);
    }
    await mkdir(dirname(absolute), { recursive: true });
    await Bun.write(absolute, content);
    let { mtimeMs } = await stat(absolute);
    // Linux file times tick every few ms: a quick save can leave the mtime unchanged, and a
    // stale save checked against it would then pass. Every save gets a later mtime.
    if (before && mtimeMs <= before.mtimeMs) {
      const later = new Date(before.mtimeMs + 1);
      await utimes(absolute, later, later);
      mtimeMs = (await stat(absolute)).mtimeMs;
    }
    return { mtimeMs };
  });
}

const exists = (absolute: string) =>
  lstat(absolute).then(
    () => true,
    () => false,
  );

/** Creates a file (and its parent folders). Throws ExistsError if anything is at `path`. */
export async function createFile(
  root: string,
  path: string,
  content = '',
): Promise<{ mtimeMs: number }> {
  const absolute = resolveInProject(root, path);
  return withFileLock(absolute, async () => {
    if (await exists(absolute)) throw new ExistsError(path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, { flag: 'wx' });
    return { mtimeMs: (await stat(absolute)).mtimeMs };
  });
}

/** Creates a folder (and its parents). Throws ExistsError if anything is at `path`. */
export async function createDir(root: string, path: string): Promise<void> {
  const absolute = resolveInProject(root, path);
  if (absolute === resolve(root)) throw new PathError('A folder needs a name');
  await withFileLock(absolute, async () => {
    if (await exists(absolute)) throw new ExistsError(path);
    await mkdir(absolute, { recursive: true });
  });
}

/** Runs fn holding the locks of both paths, taken in a fixed order so swaps can't deadlock. */
function withTwoLocks<T>(a: string, b: string, fn: () => Promise<T>): Promise<T> {
  const [first, second] = [resolve(a), resolve(b)].sort();
  return withFileLock(first!, () => withFileLock(second!, fn));
}

const posix = (path: string) => path.split(sep).join('/');

/**
 * Moves a file or folder. Fails if `from` is missing, `to` exists, or a folder would move
 * into itself. Parent folders of `to` are created.
 */
export async function rename(root: string, from: string, to: string): Promise<void> {
  const source = resolveInProject(root, from);
  const target = resolveInProject(root, to);
  const top = resolve(root);
  if (source === top || target === top)
    throw new PathError('The project folder itself cannot be renamed');
  if (target === source) return;
  if (target.startsWith(source + sep)) {
    throw new PathError(`Cannot move ${from} into itself (${to})`);
  }
  await withTwoLocks(source, target, async () => {
    if (!(await exists(source))) {
      throw Object.assign(new Error(`File not found: ${from}`), { code: 'ENOENT' });
    }
    // On a case-insensitive disk "Main.tex" → "main.tex" is the same file; allow the rename.
    const sameFile = target.toLowerCase() === source.toLowerCase();
    if (!sameFile && (await exists(target))) throw new ExistsError(to);
    await mkdir(dirname(target), { recursive: true });
    await fsRename(source, target);
  });
}

/** A sortable timestamp that is safe as a folder name: 2026-10-25T12-30-00-123Z. */
const trashStamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/**
 * Moves a file or folder to .latex-agent/trash/<timestamp>/<path>; nothing is ever deleted
 * (SPEC 4.1). Returns the project-relative trash path.
 */
export async function remove(root: string, path: string): Promise<string> {
  const source = resolveInProject(root, path);
  if (source === resolve(root)) throw new PathError('The project folder itself cannot be deleted');
  const relative = posix(source.slice(resolve(root).length + 1));
  return withFileLock(source, async () => {
    if (!(await exists(source))) {
      throw Object.assign(new Error(`File not found: ${path}`), { code: 'ENOENT' });
    }
    let stamp = trashStamp();
    let trashPath = `${APP_DATA_DIR}/trash/${stamp}/${relative}`;
    let target = resolveInProject(root, trashPath, { allowAppData: true });
    // Two deletes in the same millisecond: keep both.
    for (let n = 2; await exists(target); n++) {
      trashPath = `${APP_DATA_DIR}/trash/${stamp}-${n}/${relative}`;
      target = resolveInProject(root, trashPath, { allowAppData: true });
    }
    await mkdir(dirname(target), { recursive: true });
    await fsRename(source, target);
    return trashPath;
  });
}

/**
 * Writes an uploaded figure after checking type, size and content (SPEC 4.2). Throws
 * ExistsError if the file exists, unless `replace`, which moves the old one to the trash first.
 */
export async function writeBinary(
  root: string,
  path: string,
  bytes: Uint8Array,
  { replace = false }: { replace?: boolean } = {},
): Promise<{ size: number }> {
  checkUpload(path, bytes);
  const absolute = resolveInProject(root, path);
  if (await exists(absolute)) {
    if (!replace) throw new ExistsError(path);
    await remove(root, path);
  }
  return withFileLock(absolute, async () => {
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes, { flag: 'wx' });
    return { size: bytes.byteLength };
  });
}

const locks = new Map<string, Promise<void>>();

/** Runs fn after every earlier fn for the same path has settled. Different paths don't wait on each other. */
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((r) => (release = r));
  const tail = previous.then(() => current);
  locks.set(key, tail);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

export interface ReadLinesResult {
  text: string;
  totalLines: number;
  truncated: boolean;
  /** 1-based line to pass as `offset` to continue; set when truncated. */
  nextOffset?: number;
}

/**
 * Pages `content` (the text of `path`): up to `limit` lines from 1-based `offset`, capped at
 * 2000 lines or 50 KB. Only whole lines are returned, except a single line longer than 50 KB,
 * which is cut so the caller can still make progress.
 */
export function pageLines(
  content: string,
  path: string,
  offset = 1,
  limit = MAX_LINES,
): ReadLinesResult {
  const lines = content.split(/\r?\n/);
  if (content === '' || content.endsWith('\n')) lines.pop();
  const totalLines = lines.length;

  if (!Number.isInteger(offset) || offset < 1)
    throw new Error(`offset must be >= 1, got ${offset}`);
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`limit must be >= 1, got ${limit}`);
  if (offset > Math.max(totalLines, 1)) {
    throw new Error(`offset ${offset} is past the end of ${path} (${totalLines} lines)`);
  }

  const maxCount = Math.min(limit, MAX_LINES);
  const picked: string[] = [];
  let bytes = 0;
  for (let i = offset - 1; i < totalLines && picked.length < maxCount; i++) {
    const line = lines[i] ?? '';
    const lineBytes = Buffer.byteLength(line) + 1;
    if (bytes + lineBytes > MAX_BYTES) {
      if (picked.length === 0) {
        picked.push(`${cutToBytes(line, MAX_BYTES)} [line ${i + 1} cut at 50 KB]`);
      }
      break;
    }
    picked.push(line);
    bytes += lineBytes;
  }

  const nextLine = offset + picked.length;
  if (nextLine > totalLines) return { text: picked.join('\n'), totalLines, truncated: false };

  const remaining = totalLines - nextLine + 1;
  const hint = `[truncated: ${remaining} more lines, continue with offset=${nextLine}]`;
  return {
    text: `${picked.join('\n')}\n\n${hint}`,
    totalLines,
    truncated: true,
    nextOffset: nextLine,
  };
}

/** Longest prefix of `text` that fits in `maxBytes` of UTF-8, without splitting a character. */
function cutToBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char);
    if (bytes > maxBytes) break;
    end += char.length;
  }
  return text.slice(0, end);
}
