import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export class PathError extends Error {
  override name = 'PathError';
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Closest existing ancestor (or the path itself), so new files under a symlinked dir are caught too. */
function nearestExisting(path: string): string {
  let current = path;
  while (!existsSync(current)) current = dirname(current);
  return current;
}

/**
 * Per-project app data (threads, trash, settings); hidden from the file tree and the agent
 * (SPEC 4.5). Named after the project's working title; kept so existing data stays found.
 */
export const APP_DATA_DIR = '.latex-agent';

/** True for paths inside .latex-agent, in any letter case (macOS paths are case-insensitive). */
export function isAppDataPath(relPath: string): boolean {
  const first = relPath.split(/[\\/]/).find((s) => s !== '' && s !== '.');
  return first?.toLowerCase() === APP_DATA_DIR;
}

/**
 * Resolves a project-relative path to an absolute path inside `root`.
 * Throws a PathError for absolute paths, "..", null bytes, symlinks that escape root, and
 * paths inside .latex-agent unless `allowAppData` is set (only server internals set it).
 */
export function resolveInProject(
  root: string,
  relPath: string,
  { allowAppData = false }: { allowAppData?: boolean } = {},
): string {
  if (relPath.includes('\0')) throw new PathError('Path contains a null byte');
  if (isAbsolute(relPath)) throw new PathError(`Path must be relative to the project: ${relPath}`);
  if (relPath.split(/[\\/]/).includes('..')) {
    throw new PathError(`Path must not contain "..": ${relPath}`);
  }
  if (!allowAppData && isAppDataPath(relPath)) {
    throw new PathError(
      `${APP_DATA_DIR}/ holds the app's own data and can't be accessed: ${relPath}`,
    );
  }

  const absolute = resolve(root, relPath);
  if (!isInside(resolve(root), absolute)) {
    throw new PathError(`Path escapes the project: ${relPath}`);
  }

  const real = realpathSync(nearestExisting(absolute));
  if (!isInside(realpathSync(root), real)) {
    throw new PathError(`Path escapes the project through a symlink: ${relPath}`);
  }
  return absolute;
}
