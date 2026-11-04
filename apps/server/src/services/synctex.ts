// SyncTeX (SPEC 6.4) through the `synctex` command-line tool that ships with TeX Live.
// Coordinates are PDF big points (1/72 in) from the top-left corner of the page.

import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { SynctexBox, SynctexSource } from '@phi/shared';

import { findTexBinary } from './latex.ts';
import { resolveInProject } from './paths.ts';

const TIMEOUT_MS = 10_000;

/** SyncTeX can't answer: the tool or the .synctex.gz is missing, or nothing is at that place. */
export class SynctexError extends Error {
  override name = 'SynctexError';
}

/** Parses "Key:value" lines of the first result record. */
function firstRecord(output: string): Map<string, string> {
  const record = new Map<string, string>();
  const begin = output.indexOf('SyncTeX result begin');
  if (begin === -1) return record;
  for (const line of output.slice(begin).split('\n').slice(1)) {
    if (line.startsWith('SyncTeX result end')) break;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon);
    // A second record starts with Output: or Input: again; keep the first.
    if (record.has(key)) break;
    record.set(key, line.slice(colon + 1));
  }
  return record;
}

async function run(args: string[], cwd: string): Promise<string> {
  const tool = findTexBinary('synctex');
  if (!tool) {
    throw new SynctexError('The synctex tool is not installed. It comes with TeX Live and MacTeX.');
  }
  const proc = Bun.spawn([tool.binary, ...args], {
    cwd,
    env: { ...process.env, PATH: tool.path },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);
  return stdout;
}

/** The PDF (project-relative) and its .synctex.gz, both checked to exist. */
async function locatePdf(root: string, pdf: string): Promise<string> {
  if (!pdf.toLowerCase().endsWith('.pdf')) throw new SynctexError(`${pdf} is not a PDF`);
  const pdfPath = resolveInProject(root, pdf);
  if (!(await Bun.file(pdfPath).exists()))
    throw new SynctexError(`${pdf} does not exist; compile first.`);
  const syncPath = pdfPath.replace(/\.pdf$/i, '.synctex.gz');
  if (!(await Bun.file(syncPath).exists())) {
    throw new SynctexError(`No SyncTeX data for ${pdf}; compile the project again.`);
  }
  return pdfPath;
}

const number = (record: Map<string, string>, key: string) => {
  const value = Number(record.get(key));
  return Number.isFinite(value) ? value : null;
};

/** PDF → source: the file and line typeset at (x, y) on `page`. */
export async function synctexEdit(
  root: string,
  pdf: string,
  page: number,
  x: number,
  y: number,
): Promise<SynctexSource> {
  const pdfPath = await locatePdf(root, pdf);
  const record = firstRecord(
    await run(['edit', '-o', `${page}:${x}:${y}:${pdfPath}`], dirname(pdfPath)),
  );
  const input = record.get('Input');
  const line = number(record, 'Line');
  if (!input || line === null || line < 1)
    throw new SynctexError('Nothing in the source matches that spot.');

  // SyncTeX reports real paths (e.g. /private/tmp on macOS), possibly with "./" inside.
  const absolute = isAbsolute(input) ? resolve(input) : resolve(dirname(pdfPath), input);
  const rel = relative(await realpath(root), absolute);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new SynctexError(`That spot comes from ${absolute}, outside the project.`);
  }
  const column = number(record, 'Column');
  return {
    file: rel.split(sep).join('/'),
    line,
    column: column !== null && column >= 0 ? column : null,
  };
}

/** Source → PDF: the page and box where `file` (project-relative) at `line` is typeset. */
export async function synctexView(
  root: string,
  file: string,
  line: number,
  column: number,
  pdf: string,
): Promise<SynctexBox> {
  const pdfPath = await locatePdf(root, pdf);
  const input = resolveInProject(root, file);
  const record = firstRecord(
    await run(['view', '-i', `${line}:${column}:${input}`, '-o', pdfPath], dirname(pdfPath)),
  );
  const page = number(record, 'Page');
  const h = number(record, 'h');
  const v = number(record, 'v');
  const w = number(record, 'W');
  const height = number(record, 'H');
  if (page === null || h === null || v === null || w === null || height === null) {
    throw new SynctexError(`${file}:${line} is not in ${pdf} (is it part of this document?).`);
  }
  // h, v: the box's left edge and baseline; it extends `height` above the baseline.
  return { page, x: h, y: v - height, width: w, height };
}
