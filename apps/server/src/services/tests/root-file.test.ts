import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveRoot, RootError } from '../root-file.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'root-test-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(path: string, content = ''): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}

const DOC = '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n';
const settings = (value: unknown) => put('.latex-agent/settings.json', JSON.stringify(value));

describe('1. % !TEX root magic comment', () => {
  test('relative to the active file folder, climbing with ..', async () => {
    put('main.tex', DOC);
    put('chapters/intro.tex', '% !TEX root = ../main.tex\n\\section{Intro}');
    expect(await resolveRoot(root, 'chapters/intro.tex')).toEqual({
      root: 'main.tex',
      source: 'magic-comment',
    });
  });

  test('accepted spellings: %!TEX, % !TeX, extra spaces, quotes, and no .tex extension', async () => {
    put('thesis/thesis.tex', DOC);
    for (const line of [
      '%!TEX root = thesis.tex',
      '% !TeX root=thesis.tex',
      '  %  ! TEX   root   =   thesis.tex   ',
      '% !TEX root = "thesis.tex"',
      '% !TEX root = thesis',
    ]) {
      put('thesis/ch1.tex', `${line}\n`);
      expect(await resolveRoot(root, 'thesis/ch1.tex')).toEqual({
        root: 'thesis/thesis.tex',
        source: 'magic-comment',
      });
    }
  });

  test('only the first 5 lines count', async () => {
    put('main.tex', DOC);
    put('other.tex', DOC);
    put('a.tex', '1\n2\n3\n4\n% !TEX root = other.tex\n');
    expect((await resolveRoot(root, 'a.tex')).root).toBe('other.tex');
    put('b.tex', '1\n2\n3\n4\n5\n% !TEX root = other.tex\n');
    expect(await resolveRoot(root, 'b.tex')).toEqual({ root: 'main.tex', source: 'main.tex' });
  });

  test('beats settings.json and \\documentclass', async () => {
    put('main.tex', DOC);
    put('book.tex', DOC);
    settings({ rootFile: 'main.tex' });
    put('ch.tex', '% !TEX root = book.tex');
    expect((await resolveRoot(root, 'ch.tex')).root).toBe('book.tex');
  });

  test('a magic comment naming a missing file is a clear error, not a silent fallback', async () => {
    put('main.tex', DOC);
    put('chapters/intro.tex', '% !TEX root = ../mian.tex');
    await expect(resolveRoot(root, 'chapters/intro.tex')).rejects.toThrow(
      'The "% !TEX root" in chapters/intro.tex names ../mian.tex, but mian.tex doesn\'t exist.',
    );
  });

  test('a magic comment pointing outside the project is refused', async () => {
    put('main.tex', DOC);
    put('a.tex', '% !TEX root = ../../etc/passwd');
    await expect(resolveRoot(root, 'a.tex')).rejects.toThrow('points outside the project');
    put('b.tex', '% !TEX root = /etc/passwd');
    await expect(resolveRoot(root, 'b.tex')).rejects.toThrow('points outside the project');
  });

  test('the magic comment is only read from the active file', async () => {
    put('main.tex', `% !TEX root = other.tex\n${DOC}`);
    put('other.tex', DOC);
    // No active file: step 1 is skipped; two \documentclass files, main.tex wins.
    expect(await resolveRoot(root)).toEqual({ root: 'main.tex', source: 'main.tex' });
  });

  test('a missing or app-data active file falls through or is refused', async () => {
    put('main.tex', DOC);
    expect((await resolveRoot(root, 'gone.tex')).root).toBe('main.tex');
    await expect(resolveRoot(root, '.latex-agent/settings.json')).rejects.toBeInstanceOf(RootError);
  });
});

describe('2. .latex-agent/settings.json rootFile', () => {
  test('is used when the active file has no magic comment', async () => {
    put('main.tex', DOC);
    put('paper/paper.tex', DOC);
    settings({ rootFile: 'paper/paper.tex' });
    expect(await resolveRoot(root, 'main.tex')).toEqual({
      root: 'paper/paper.tex',
      source: 'settings',
    });
  });

  test('empty or absent rootFile falls through', async () => {
    put('main.tex', DOC);
    settings({ rootFile: '' });
    expect((await resolveRoot(root)).source).toBe('documentclass');
    settings({ theme: 'dark' });
    expect((await resolveRoot(root)).source).toBe('documentclass');
  });

  test('a rootFile that does not exist, or broken JSON, is a clear error', async () => {
    put('main.tex', DOC);
    settings({ rootFile: 'thesis.tex' });
    await expect(resolveRoot(root)).rejects.toThrow(
      '"rootFile" in .latex-agent/settings.json is thesis.tex, which doesn\'t exist.',
    );
    put('.latex-agent/settings.json', '{ nope');
    await expect(resolveRoot(root)).rejects.toThrow('is not valid JSON');
  });
});

describe('3. the only .tex file with \\documentclass', () => {
  test('wins over main.tex when it is the only one', async () => {
    put('main.tex', '\\input{x}');
    put('paper.tex', DOC);
    expect(await resolveRoot(root)).toEqual({ root: 'paper.tex', source: 'documentclass' });
  });

  test('ignores commented-out \\documentclass and non-.tex files', async () => {
    put('notes.tex', '% \\documentclass{article}\nnot a root');
    put('style.cls', DOC);
    put('paper/paper.tex', DOC);
    expect((await resolveRoot(root)).root).toBe('paper/paper.tex');
  });

  test('ignores .tex files in the trash', async () => {
    put('paper.tex', DOC);
    put('.latex-agent/trash/2026/old.tex', DOC);
    expect((await resolveRoot(root)).root).toBe('paper.tex');
  });
});

describe('4. main.tex, and no root', () => {
  test('main.tex when several files have \\documentclass', async () => {
    put('main.tex', DOC);
    put('poster.tex', DOC);
    expect(await resolveRoot(root)).toEqual({ root: 'main.tex', source: 'main.tex' });
  });

  test('main.tex even without \\documentclass in any file', async () => {
    put('main.tex', '\\input{preamble}');
    expect(await resolveRoot(root)).toEqual({ root: 'main.tex', source: 'main.tex' });
  });

  test('several candidates and no main.tex: error naming them and the fixes', async () => {
    put('a.tex', DOC);
    put('b.tex', DOC);
    await expect(resolveRoot(root)).rejects.toThrow(
      /Several files have \\documentclass \(a\.tex, b\.tex\).*% !TEX root.*rootFile/,
    );
  });

  test('nothing at all: a clear error', async () => {
    put('notes.txt', 'hi');
    await expect(resolveRoot(root)).rejects.toThrow('No file to compile');
    await expect(resolveRoot(root)).rejects.toBeInstanceOf(RootError);
  });
});
