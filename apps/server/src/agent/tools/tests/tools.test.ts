import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CompileResult } from '@phi/shared';

import { findLatexmk } from '../../../services/latex.ts';
import { compiledInputs } from '../../../services/project-compile.ts';
import { createWorkspace } from '../../workspace.ts';
import { createCompileTool, summarizeCompile } from '../compile.ts';
import { createListFilesTool } from '../list-files.ts';
import { createReadFileTool } from '../read-file.ts';
import { createSearchTool } from '../search.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tools-test-'));
  mkdirSync(join(root, 'chapters'));
  writeFileSync(join(root, 'main.tex'), '\\input{chapters/intro}\n');
  writeFileSync(join(root, 'chapters', 'intro.tex'), '\\section{Intro}\\label{sec:intro}\n');
  writeFileSync(join(root, 'empty.tex'), '');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const textOf = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map((c) => c.text ?? '').join('');

test('list_files: one path per line, folders with a trailing slash', async () => {
  const result = await createListFilesTool(root).execute('id', {});
  expect(textOf(result)).toBe(
    'chapters/\nchapters/intro.tex (text)\nempty.tex (text)\nmain.tex (text)',
  );
  expect(result.details).toEqual({ count: 4 });
});

test('read_file: says so for an empty file', async () => {
  const result = await createReadFileTool(root, createWorkspace(root)).execute('id', {
    path: 'empty.tex',
  });
  expect(textOf(result)).toBe('(empty file)');
});

test('read_file: passes offset and limit through', async () => {
  writeFileSync(join(root, 'n.tex'), 'a\nb\nc\nd\n');
  const result = await createReadFileTool(root, createWorkspace(root)).execute('id', {
    path: 'n.tex',
    offset: 2,
    limit: 2,
  });
  expect(textOf(result)).toBe('b\nc\n\n[truncated: 1 more lines, continue with offset=4]');
});

test('search: file:line: text, and a clear no-match message', async () => {
  const tool = createSearchTool(root, createWorkspace(root));
  expect(textOf(await tool.execute('id', { query: 'label{' }))).toBe(
    'chapters/intro.tex:1: \\section{Intro}\\label{sec:intro}',
  );
  expect(textOf(await tool.execute('id', { query: 'zzz' }))).toBe('No matches for "zzz".');
});

test('search: notes when it stopped at the limit', async () => {
  writeFileSync(join(root, 'big.tex'), Array.from({ length: 120 }, () => 'hit').join('\n'));
  const out = textOf(
    await createSearchTool(root, createWorkspace(root)).execute('id', { query: 'hit' }),
  );
  expect(out.split('\n')).toHaveLength(101);
  expect(out).toEndWith('[stopped at 100 matches; narrow the query]');
});

test('tools throw on failure and honour an aborted signal', async () => {
  await expect(
    createReadFileTool(root, createWorkspace(root)).execute('id', { path: '/etc/passwd' }),
  ).rejects.toThrow('relative');
  await expect(
    createSearchTool(root, createWorkspace(root)).execute('id', { query: '(', isRegex: true }),
  ).rejects.toThrow('Invalid regex');
  const aborted = AbortSignal.abort(new Error('stop'));
  await expect(createListFilesTool(root).execute('id', {}, aborted)).rejects.toThrow('stop');
  await expect(
    createReadFileTool(root, createWorkspace(root)).execute('id', { path: 'main.tex' }, aborted),
  ).rejects.toThrow('stop');
});

describe('summarizeCompile', () => {
  const base: CompileResult = {
    root: 'main.tex',
    ok: true,
    durationMs: 1234,
    errors: [],
    warnings: [],
    logTail: '',
  };
  const warning = { file: '', line: 3, message: 'LaTeX Warning: x' };
  const tail = Array.from({ length: 40 }, (_, i) => `log ${i + 1}`).join('\n');

  test('success', () => {
    expect(summarizeCompile(base)).toBe('Compiled main.tex successfully in 1.2 s, 0 warnings.');
    expect(summarizeCompile({ ...base, warnings: [warning] })).toBe(
      'Compiled main.tex successfully in 1.2 s, 1 warning.',
    );
  });

  test('located errors only: no log tail', () => {
    const result: CompileResult = {
      ...base,
      ok: false,
      logTail: tail,
      warnings: [warning, warning],
      errors: [
        { file: 'main.tex', line: 3, message: 'Undefined control sequence \\foo' },
        { file: 'chapters/a.tex', line: 9, message: 'Missing $ inserted.' },
      ],
    };
    expect(summarizeCompile(result)).toBe(
      [
        'Compiling main.tex failed in 1.2 s with 2 errors and 2 warnings:',
        'main.tex:3: Undefined control sequence \\foo',
        'chapters/a.tex:9: Missing $ inserted.',
      ].join('\n'),
    );
  });

  test('an error without file:line adds the last 15 log lines', () => {
    const result: CompileResult = {
      ...base,
      ok: false,
      logTail: tail,
      errors: [
        { file: '', line: null, message: 'Emergency stop: job aborted, no legal \\end found' },
      ],
    };
    const lines = summarizeCompile(result).split('\n');
    expect(lines.slice(0, 4)).toEqual([
      'Compiling main.tex failed in 1.2 s with 1 error and 0 warnings:',
      'Emergency stop: job aborted, no legal \\end found',
      '',
      'Last 15 log lines:',
    ]);
    expect(lines.slice(4)).toEqual(tail.split('\n').slice(-15));
  });

  test('a failure with no parsed errors also adds the log tail', () => {
    expect(summarizeCompile({ ...base, ok: false, logTail: tail })).toContain('Last 15 log lines:');
  });
});

test('list_files labels each file with its kind and hides .latex-agent', async () => {
  mkdirSync(join(root, 'figures'));
  writeFileSync(join(root, 'figures', 'plot.png'), '');
  writeFileSync(join(root, 'paper.pdf'), '');
  mkdirSync(join(root, '.latex-agent'));
  writeFileSync(join(root, '.latex-agent', 'settings.json'), '{}');
  const out = textOf(await createListFilesTool(root).execute('id', {}));
  expect(out).toContain('figures/plot.png (image)');
  expect(out).toContain('paper.pdf (pdf)');
  expect(out).not.toContain('.latex-agent');
});

test('read_file refuses images, PDFs, binaries and app data with a clear error', async () => {
  writeFileSync(join(root, 'plot.png'), 'x');
  const read = (path: string) =>
    createReadFileTool(root, createWorkspace(root)).execute('id', { path });
  await expect(read('plot.png')).rejects.toThrow(
    'plot.png is an image; read_file only reads text files',
  );
  await expect(read('paper.pdf')).rejects.toThrow('paper.pdf is a PDF');
  await expect(read('data.zip')).rejects.toThrow('data.zip is a binary file');
  await expect(read('.latex-agent/settings.json')).rejects.toThrow('app');
});

test.skipIf(findLatexmk() === null)(
  'compile follows the active file and notes unsaved edits in the files it compiled',
  async () => {
    writeFileSync(
      join(root, 'main.tex'),
      '\\documentclass{article}\n\\begin{document}\n\\input{chapters/intro}\n\\end{document}\n',
    );
    writeFileSync(join(root, 'chapters', 'intro.tex'), '% !TEX root = ../main.tex\nHello.\n');
    writeFileSync(
      join(root, 'notes.tex'),
      '\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n',
    );
    const workspace = createWorkspace(root);
    workspace.setSnapshot({
      activeFile: 'chapters/intro.tex',
      cursorLine: 2,
      dirtyFiles: [
        { path: 'chapters/intro.tex', content: '% !TEX root = ../main.tex\nHello, world.\n' },
        { path: 'empty.tex', content: 'not part of this build' },
      ],
      revertedToolCallIds: [],
    });

    const result = await createCompileTool(root, workspace).execute('id', {});
    // Two files have \documentclass, so only the magic comment in the active file picks main.tex.
    expect(result.details.root).toBe('main.tex');
    expect(await compiledInputs(root, 'main.tex')).toEqual(
      expect.arrayContaining(['main.tex', 'chapters/intro.tex']),
    );
    const text = textOf(result);
    expect(text).toStartWith('Compiled main.tex successfully');
    expect(text).toContain('Note: chapters/intro.tex has unsaved edits in the editor');
    expect(text).not.toContain('empty.tex');

    workspace.setSnapshot({ ...workspace.snapshot!, dirtyFiles: [] });
    expect(textOf(await createCompileTool(root, workspace).execute('id', {}))).not.toContain(
      'Note:',
    );
  },
  60_000,
);
