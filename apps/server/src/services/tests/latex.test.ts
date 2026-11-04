import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compile, findLatexmk } from '../latex.ts';

const hasLatexmk = findLatexmk() !== null;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'latex-test-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const doc = (body: string, preamble = '') =>
  `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;

describe('findLatexmk', () => {
  /** A fake executable latexmk in its own folder. */
  const fakeTexBin = () => {
    const bin = join(root, 'texbin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'latexmk'), '#!/bin/sh\n');
    chmodSync(join(bin, 'latexmk'), 0o755);
    return bin;
  };

  test('null when latexmk is neither on PATH nor in a fallback folder', () => {
    expect(findLatexmk(root, [])).toBeNull();
    expect(findLatexmk('', [join(root, 'missing')])).toBeNull();
  });

  test('uses PATH first and leaves it unchanged', () => {
    const bin = fakeTexBin();
    expect(findLatexmk(bin, ['/nowhere'])).toEqual({ latexmk: join(bin, 'latexmk'), path: bin });
  });

  test('falls back to a TeX bin folder missing from PATH, and appends it for pdflatex', () => {
    const bin = fakeTexBin();
    expect(findLatexmk('/usr/bin:/bin', [bin])).toEqual({
      latexmk: join(bin, 'latexmk'),
      path: `/usr/bin:/bin:${bin}`,
    });
  });
});

test.skipIf(hasLatexmk)('compile throws a clear error when latexmk is not installed', async () => {
  await expect(compile(root)).rejects.toThrow('latexmk is not installed');
});

describe.skipIf(!hasLatexmk)('with latexmk', () => {
  test('compiles a valid document', async () => {
    writeFileSync(join(root, 'main.tex'), doc('Hello.'));
    const run = await compile(root);
    expect(run.exitCode).toBe(0);
    expect(run.timedOut).toBe(false);
    expect(run.log).toContain('Output written on main.pdf');
    expect(existsSync(join(root, 'main.pdf'))).toBe(true);
    expect(existsSync(join(root, 'main.synctex.gz'))).toBe(true);
  }, 30_000);

  test('compiles a main file in a subdirectory from that directory', async () => {
    mkdirSync(join(root, 'paper'));
    writeFileSync(join(root, 'paper', 'part.tex'), 'From a sibling file.');
    writeFileSync(join(root, 'paper', 'thesis.tex'), doc('\\input{part}'));
    const run = await compile(root, 'paper/thesis.tex');
    expect(run.exitCode).toBe(0);
    expect(existsSync(join(root, 'paper', 'thesis.pdf'))).toBe(true);
  }, 30_000);

  test('reports a failing document with a non-zero exit code and its log', async () => {
    writeFileSync(join(root, 'main.tex'), doc('\\undefinedmacro'));
    const run = await compile(root);
    expect(run.exitCode).not.toBe(0);
    expect(run.log).toContain('./main.tex:4: Undefined control sequence');
  }, 30_000);

  test('does not run shell escapes', async () => {
    writeFileSync(join(root, 'main.tex'), doc('\\immediate\\write18{touch pwned}Hi.'));
    await compile(root);
    expect(existsSync(join(root, 'pwned'))).toBe(false);
  }, 30_000);

  test('ignores a latexmkrc in the project', async () => {
    writeFileSync(join(root, 'latexmkrc'), 'system("touch pwned");');
    writeFileSync(join(root, 'main.tex'), doc('Hi.'));
    await compile(root);
    expect(existsSync(join(root, 'pwned'))).toBe(false);
  }, 30_000);

  test('kills latexmk and pdflatex when aborted', async () => {
    // A TeX infinite loop: pdflatex would spin until the timeout.
    writeFileSync(join(root, 'spin.tex'), doc('\\loop\\iftrue\\repeat'));
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('stop')), 1_000);
    const started = performance.now();
    await expect(compile(root, 'spin.tex', controller.signal)).rejects.toThrow('stop');
    expect(performance.now() - started).toBeLessThan(5_000);

    await Bun.sleep(500);
    const ps = Bun.spawnSync(['pgrep', '-f', 'spin\\.tex']);
    expect(ps.stdout.toString().trim()).toBe('');
  }, 30_000);

  test('rejects a main file outside the project or missing', async () => {
    await expect(compile(root, '../main.tex')).rejects.toThrow('".."');
    await expect(compile(root, 'nope.tex')).rejects.toThrow('Main file not found');
  });
});
