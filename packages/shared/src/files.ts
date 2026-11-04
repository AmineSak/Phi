import type { FileKind } from './api.ts';

/** Extensions the editor opens as text. Extensionless names listed separately. */
const TEXT_EXTENSIONS = new Set([
  'tex',
  'ltx',
  'latex',
  'bib',
  'bbx',
  'cbx',
  'sty',
  'cls',
  'bst',
  'dtx',
  'ins',
  'def',
  'cfg',
  'clo',
  'fd',
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'xml',
  'gitignore',
  'latexmkrc',
  'tikz',
  'pgf',
  'asy',
  'gnuplot',
  'gp',
  'dat',
  'r',
  'py',
  'lua',
]);
const TEXT_NAMES = new Set(['latexmkrc', '.latexmkrc', 'makefile', 'readme', 'license']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'eps']);

/** The kind of a file, from its name: only text opens in the editor (SPEC 4.2). */
export function fileKind(path: string): FileKind {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (TEXT_NAMES.has(name)) return 'text';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 && !name.startsWith('.')) return 'binary';
  const ext = name.slice(dot + 1);
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  return 'binary';
}

/** The PDF a root file compiles to, next to it: chapters/thesis.tex → chapters/thesis.pdf. */
export function pdfPathFor(root: string): string {
  return root.replace(/\.[^./]*$/, '') + '.pdf';
}
