import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compile, findTexBinary } from '../latex.ts';
import { SynctexError, synctexEdit, synctexView } from '../synctex.ts';

const available = findTexBinary('latexmk') !== null && findTexBinary('synctex') !== null;
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'synctex-test-'));
  mkdirSync(join(root, 'chapters'));
  writeFileSync(
    join(root, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nFirst page text in main.\n\n\\input{chapters/intro}\n\\end{document}\n',
  );
  writeFileSync(
    join(root, 'chapters', 'intro.tex'),
    '% !TEX root = ../main.tex\n\\section{Intro}\nIntro paragraph one.\n\nIntro paragraph two is here.\n',
  );
  if (available) await compile(root, 'main.tex');
}, 60_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

test.skipIf(!available)('view: a line of an \\input file maps to a box on page 1', async () => {
  const box = await synctexView(root, 'chapters/intro.tex', 5, 0, 'main.pdf');
  expect(box.page).toBe(1);
  expect(box.width).toBeGreaterThan(100);
  expect(box.height).toBeGreaterThan(5);
  expect(box.y).toBeGreaterThan(100);
  expect(box.x).toBeGreaterThan(0);
});

test.skipIf(!available)(
  'edit: a spot in that box maps back to the file and line (round trip)',
  async () => {
    const box = await synctexView(root, 'chapters/intro.tex', 5, 0, 'main.pdf');
    const source = await synctexEdit(
      root,
      'main.pdf',
      box.page,
      box.x + 20,
      box.y + box.height / 2,
    );
    expect(source.file).toBe('chapters/intro.tex');
    expect(source.line).toBe(5);
    // And a spot in the main file's text.
    const main = await synctexView(root, 'main.tex', 3, 0, 'main.pdf');
    expect(
      (await synctexEdit(root, 'main.pdf', main.page, main.x + 10, main.y + main.height / 2)).file,
    ).toBe('main.tex');
  },
);

test.skipIf(!available)(
  'clear errors: no PDF, no SyncTeX data, nothing at that place',
  async () => {
    await expect(synctexView(root, 'main.tex', 3, 0, 'missing.pdf')).rejects.toThrow(
      'missing.pdf does not exist; compile first.',
    );
    writeFileSync(join(root, 'other.pdf'), '%PDF-1.4');
    await expect(synctexEdit(root, 'other.pdf', 1, 10, 10)).rejects.toThrow(
      'No SyncTeX data for other.pdf',
    );
    await expect(synctexView(root, 'chapters/missing.tex', 1, 0, 'main.pdf')).rejects.toThrow(
      SynctexError,
    );
    await expect(synctexView(root, '../outside.tex', 1, 0, 'main.pdf')).rejects.toThrow();
  },
);
