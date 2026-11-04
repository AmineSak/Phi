// Edit matching shared by the server (validating proposals) and the web app (re-validating
// on accept, reverting). Pure TypeScript: no Bun, Node or DOM APIs.

export interface TextEdit {
  /** Text to replace; must occur exactly once in the original content. */
  oldText: string;
  newText: string;
}

/** One replacement, located in the ORIGINAL content. */
export interface Hunk {
  /** Offsets in the original content: [start, end). */
  start: number;
  end: number;
  /** The original text at [start, end): may differ from the requested oldText after a fuzzy match. */
  oldText: string;
  newText: string;
}

export interface ApplyResult {
  newContent: string;
  /** Sorted by position. */
  hunks: Hunk[];
  /** Unified diff (hunk headers and lines only, no file headers). */
  diff: string;
}

export class EditMatchError extends Error {
  override name = 'EditMatchError';
}

const DIFF_CONTEXT = 2;

/** A normalized copy of `text` with, for each of its characters, the original offset. */
interface Normalized {
  text: string;
  offsets: number[];
}

const CHAR_MAP: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '–': '-',
  '—': '-',
  '−': '-',
};

/**
 * Normalizes for fuzzy matching: CRLF to LF, trailing spaces and tabs per line dropped, curly
 * quotes and dashes to ASCII. Every kept character remembers where it came from.
 */
function normalize(text: string): Normalized {
  const chars: string[] = [];
  const offsets: number[] = [];
  let lineStart = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\r' && text[i + 1] === '\n') continue;
    if (ch === '\n') {
      // Drop the trailing whitespace of the line that just ended.
      while (chars.length > lineStart && (chars.at(-1) === ' ' || chars.at(-1) === '\t')) {
        chars.pop();
        offsets.pop();
      }
      chars.push('\n');
      offsets.push(i);
      lineStart = chars.length;
      continue;
    }
    chars.push(CHAR_MAP[ch] ?? ch);
    offsets.push(i);
  }
  while (chars.length > lineStart && (chars.at(-1) === ' ' || chars.at(-1) === '\t')) {
    chars.pop();
    offsets.pop();
  }
  return { text: chars.join(''), offsets };
}

/** Every start offset of `needle` in `haystack`, overlapping occurrences included. */
function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    found.push(at);
  }
  return found;
}

/** 1-based line of `offset` in `text`. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

const lineList = (text: string, offsets: number[]) =>
  offsets.map((o) => lineAt(text, o)).join(', ');

/** Locates one edit's oldText in `content`: exact first, then on the normalized view. */
function locate(content: string, normalized: () => Normalized, edit: TextEdit, n: number) {
  const label = `Edit ${n}`;
  if (edit.oldText === '') {
    throw new EditMatchError(
      `${label}: oldText is empty. To insert text, include the neighbouring text in oldText and repeat it in newText.`,
    );
  }
  const exact = occurrences(content, edit.oldText);
  if (exact.length === 1) return { start: exact[0]!, end: exact[0]! + edit.oldText.length };
  if (exact.length > 1) {
    throw new EditMatchError(
      `${label}: oldText occurs ${exact.length} times (lines ${lineList(content, exact)}); include more surrounding text so it matches exactly once.`,
    );
  }

  const view = normalized();
  const needle = normalize(edit.oldText).text;
  const fuzzy = needle ? occurrences(view.text, needle) : [];
  if (fuzzy.length === 1) {
    const at = fuzzy[0]!;
    return { start: view.offsets[at]!, end: view.offsets[at + needle.length - 1]! + 1 };
  }
  if (fuzzy.length > 1) {
    const starts = fuzzy.map((at) => view.offsets[at]!);
    throw new EditMatchError(
      `${label}: oldText occurs ${fuzzy.length} times (lines ${lineList(content, starts)}); include more surrounding text so it matches exactly once.`,
    );
  }
  throw new EditMatchError(
    `${label}: oldText was not found in the file. Re-read the file and copy the text to replace exactly.`,
  );
}

/**
 * Applies `edits` to `content`. Each oldText is matched against the ORIGINAL content (not
 * after earlier edits): exactly, or failing that on a normalized view (trailing whitespace,
 * curly quotes and dashes, CRLF). Throws an EditMatchError when an oldText matches nowhere or
 * several times, or when two edits overlap.
 */
export function applyEdits(content: string, edits: TextEdit[]): ApplyResult {
  if (edits.length === 0) throw new EditMatchError('No edits given.');
  let view: Normalized | undefined;
  const normalized = () => (view ??= normalize(content));

  const located = edits.map((edit, i) => ({
    ...locate(content, normalized, edit, i + 1),
    edit,
    n: i + 1,
  }));
  const sorted = [...located].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = [sorted[i - 1]!, sorted[i]!];
    if (b.start < a.end) {
      const [first, second] = [a.n, b.n].sort((x, y) => x - y);
      throw new EditMatchError(
        `Edits ${first} and ${second} overlap (line ${lineAt(content, b.start)}); merge them into one edit.`,
      );
    }
  }

  const hunks: Hunk[] = sorted.map(({ start, end, edit }) => ({
    start,
    end,
    oldText: content.slice(start, end),
    newText: edit.newText,
  }));
  let newContent = '';
  let cursor = 0;
  for (const hunk of hunks) {
    newContent += content.slice(cursor, hunk.start) + hunk.newText;
    cursor = hunk.end;
  }
  newContent += content.slice(cursor);
  return { newContent, hunks, diff: unifiedDiff(content, hunks) };
}

/** A unified diff of `hunks` (sorted, non-overlapping) applied to `content`. */
export function unifiedDiff(content: string, hunks: Hunk[]): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let lineDelta = 0;
  for (const hunk of hunks) {
    // The whole lines the hunk touches.
    const firstLine = lineAt(content, hunk.start);
    const lineStart = content.lastIndexOf('\n', hunk.start - 1) + 1;
    const nextBreak = content.indexOf('\n', hunk.end);
    const lineEnd = nextBreak === -1 ? content.length : nextBreak;
    const oldLines = content.slice(lineStart, lineEnd).split('\n');
    const newLines = (
      content.slice(lineStart, hunk.start) +
      hunk.newText +
      content.slice(hunk.end, lineEnd)
    ).split('\n');
    const before = lines.slice(Math.max(0, firstLine - 1 - DIFF_CONTEXT), firstLine - 1);
    const after = lines.slice(
      firstLine - 1 + oldLines.length,
      firstLine - 1 + oldLines.length + DIFF_CONTEXT,
    );
    const oldStart = firstLine - before.length;
    const oldCount = before.length + oldLines.length + after.length;
    const newCount = before.length + newLines.length + after.length;
    out.push(`@@ -${oldStart},${oldCount} +${oldStart + lineDelta},${newCount} @@`);
    out.push(...before.map((l) => ` ${l}`));
    out.push(...oldLines.map((l) => `-${l}`));
    out.push(...newLines.map((l) => `+${l}`));
    out.push(...after.map((l) => ` ${l}`));
    lineDelta += newLines.length - oldLines.length;
  }
  return out.join('\n');
}
