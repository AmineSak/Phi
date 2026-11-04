import { listFiles, readText } from './fs.ts';

const SEARCHED_EXTENSIONS = ['.tex', '.bib', '.sty', '.cls'];
export const MAX_MATCHES = 100;
const MAX_LINE_CHARS = 200;

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  /** True when the search stopped at MAX_MATCHES. */
  limited: boolean;
}

/** Reads a project file's text; the agent passes one that prefers unsaved editor buffers. */
export type ReadText = (path: string) => Promise<string>;

/**
 * Searches .tex/.bib/.sty/.cls files line by line. A plain query matches case-insensitively;
 * a regex uses JavaScript syntax as written. Throws on an invalid regex.
 */
export async function searchProject(
  root: string,
  query: string,
  isRegex = false,
  signal?: AbortSignal,
  read: ReadText = async (path) => (await readText(root, path)).content,
): Promise<SearchResult> {
  if (!query) throw new Error('Search query is empty');
  const matchesLine = lineMatcher(query, isRegex);
  const files = (await listFiles(root)).filter(
    (entry) => !entry.isDir && SEARCHED_EXTENSIONS.some((ext) => entry.path.endsWith(ext)),
  );

  const matches: SearchMatch[] = [];
  for (const { path } of files) {
    signal?.throwIfAborted();
    const lines = (await read(path)).split(/\r?\n/);
    for (const [index, text] of lines.entries()) {
      if (!matchesLine(text)) continue;
      if (matches.length === MAX_MATCHES) return { matches, limited: true };
      matches.push({ path, line: index + 1, text: shorten(text.trim()) });
    }
  }
  return { matches, limited: false };
}

function lineMatcher(query: string, isRegex: boolean): (line: string) => boolean {
  if (!isRegex) {
    const needle = query.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
  let regex: RegExp;
  try {
    regex = new RegExp(query);
  } catch (err) {
    throw new Error(`Invalid regex ${JSON.stringify(query)}: ${(err as Error).message}`);
  }
  return (line) => regex.test(line);
}

function shorten(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
}
