import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CompileResult, RootResponse, SynctexBox } from '@phi/shared';

import { findLatexmk } from '../../services/latex.ts';
import { compileHandlers } from '../compile.ts';
import { pdfWorker } from '../pdf-worker.ts';
import { guard } from '../security.ts';
import { BASE, tempProject } from './test-project.ts';

const hasLatexmk = findLatexmk() !== null;

let project: ReturnType<typeof tempProject>;
let handlers: ReturnType<typeof compileHandlers>;

beforeEach(() => {
  project = tempProject();
  handlers = compileHandlers(project.root);
});

afterEach(() => project.remove());

const put = (path: string, content: string | Uint8Array) => {
  mkdirSync(join(project.root, path, '..'), { recursive: true });
  writeFileSync(join(project.root, path), content);
};

const post = (body?: unknown) =>
  guard(
    handlers.compile,
    3000,
  )(
    new Request(`${BASE}/api/compile`, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const getPdf = (query = '') => guard(handlers.pdf, 3000)(new Request(`${BASE}/api/pdf${query}`));
const getRoot = (query = '') => guard(handlers.root, 3000)(new Request(`${BASE}/api/root${query}`));

const DOC = (body: string) =>
  `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

test('GET /api/pdf is 404 before the first compile, naming the root', async () => {
  const res = await getPdf();
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: 'No PDF yet for main.tex; compile first' });
});

test('GET /api/pdf?root= rejects non-.tex roots and app data', async () => {
  expect((await getPdf('?root=main.pdf')).status).toBe(400);
  expect((await getPdf('?root=.latex-agent/x.tex')).status).toBe(400);
  expect((await getPdf('?root=../x.tex')).status).toBe(400);
});

test('GET /api/root follows SPEC 4.3 from the active file', async () => {
  put('chapters/intro.tex', '% !TEX root = ../main.tex\n\\section{Intro}');
  expect((await (await getRoot('?activeFile=chapters/intro.tex')).json()) as RootResponse).toEqual({
    root: 'main.tex',
    source: 'magic-comment',
  });
  expect(await (await getRoot()).json()).toEqual({ root: 'main.tex', source: 'documentclass' });
  put('chapters/bad.tex', '% !TEX root = ../nope.tex');
  const bad = await getRoot('?activeFile=chapters/bad.tex');
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toContain('nope.tex');
});

test('POST /api/compile rejects a bad body', async () => {
  expect((await post({ activeFile: 42 })).status).toBe(400);
  const notJson = await guard(
    handlers.compile,
    3000,
  )(new Request(`${BASE}/api/compile`, { method: 'POST', body: '{nope' }));
  expect(notJson.status).toBe(400);
});

test('GET /pdf.worker.mjs serves the pdf.js worker as JavaScript', async () => {
  const res = pdfWorker();
  expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  expect((await res.text()).length).toBeGreaterThan(100_000);
});

test.skipIf(hasLatexmk)('POST /api/compile → 500 naming latexmk when it is missing', async () => {
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const res = await post();
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain('latexmk is not installed');
  } finally {
    log.mockRestore();
  }
});

describe.skipIf(!hasLatexmk)('with latexmk', () => {
  test('compiles the project, returns the root, and serves the PDF uncached', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    const result = (await res.json()) as CompileResult;
    expect(result).toMatchObject({ root: 'main.tex', ok: true, errors: [] });
    expect(result.logTail).toContain('Output written on main.pdf');

    const pdf = await getPdf('?root=main.tex');
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('cache-control')).toBe('no-store');
    expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe('%PDF-');
  }, 30_000);

  test('from a chapter with % !TEX root, compiles main.tex with the \\input and a figure', async () => {
    put(
      'chapters/intro.tex',
      '% !TEX root = ../main.tex\n\\section{Intro}\nSee the figure.\n' +
        '\\begin{figure}\\centering\\includegraphics[width=2cm]{figures/plot.pdf}\\end{figure}\n',
    );
    put(
      'main.tex',
      `\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\input{chapters/intro}\n\\end{document}\n`,
    );
    put('figures/plot.pdf', await Bun.file(await makePdf()).bytes());

    const result = (await (
      await post({ activeFile: 'chapters/intro.tex' })
    ).json()) as CompileResult;
    expect(result).toMatchObject({ root: 'main.tex', ok: true });
    expect(existsSync(join(project.root, 'main.pdf'))).toBe(true);
  }, 60_000);

  test('a root in a subfolder compiles there; its PDF and error paths follow it', async () => {
    put('thesis/thesis.tex', DOC('\\input{chapters/one}'));
    put('thesis/chapters/one.tex', 'Fine.\n\\undefinedthing\n');
    put('.latex-agent/settings.json', JSON.stringify({ rootFile: 'thesis/thesis.tex' }));

    const result = (await (await post({ activeFile: 'main.tex' })).json()) as CompileResult;
    expect(result.root).toBe('thesis/thesis.tex');
    expect(result.errors).toEqual([
      {
        file: 'thesis/chapters/one.tex',
        line: 2,
        message: 'Undefined control sequence \\undefinedthing',
      },
    ]);
    expect(existsSync(join(project.root, 'thesis/thesis.pdf'))).toBe(true);
    expect((await getPdf('?root=thesis/thesis.tex')).status).toBe(200);
    expect((await getPdf()).status).toBe(200); // default root is now the settings one
  }, 60_000);

  test('reports parsed errors for a broken document', async () => {
    put('main.tex', DOC('\\foo'));
    const result = (await (await post()).json()) as CompileResult;
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { file: 'main.tex', line: 3, message: 'Undefined control sequence \\foo' },
    ]);
  }, 30_000);

  test('concurrent requests share one compile', async () => {
    const [a, b] = await Promise.all([post(), post()]);
    const [first, second] = [(await a.json()) as CompileResult, (await b.json()) as CompileResult];
    expect(second).toEqual(first);
    const third = (await (await post()).json()) as CompileResult;
    expect(third.ok).toBe(true);
  }, 60_000);
});

/** A real one-page PDF to \includegraphics, made by compiling a tiny standalone document. */
async function makePdf(): Promise<string> {
  const dir = join(project.root, '.fig-build');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fig.tex'), DOC('\\rule{1cm}{1cm}'));
  const latexmk = findLatexmk();
  if (!latexmk) throw new Error('latexmk missing');
  Bun.spawnSync(
    [latexmk.latexmk, '-pdf', '-interaction=nonstopmode', '-no-shell-escape', 'fig.tex'],
    {
      cwd: dir,
      env: { ...process.env, PATH: latexmk.path },
    },
  );
  return join(dir, 'fig.pdf');
}

const getSync = (kind: 'edit' | 'view', query: Record<string, string>) =>
  guard(
    kind === 'edit' ? handlers.synctexEdit : handlers.synctexView,
    3000,
  )(new Request(`${BASE}/api/synctex/${kind}?${new URLSearchParams(query)}`));

describe.skipIf(!hasLatexmk)('SyncTeX routes (SPEC 6.4)', () => {
  test('view and edit on a multi-file project; the PDF defaults to the root of the file', async () => {
    put('main.tex', DOC('Text in main.\n\n\\input{chapters/one}'));
    put('chapters/one.tex', '% !TEX root = ../main.tex\nA paragraph in chapter one.\n');
    expect((await post({ activeFile: 'chapters/one.tex' })).status).toBe(200);

    const view = await getSync('view', { file: 'chapters/one.tex', line: '2' });
    expect(view.status).toBe(200);
    const box = (await view.json()) as SynctexBox;
    expect(box.page).toBe(1);

    const edit = await getSync('edit', {
      page: String(box.page),
      x: String(box.x + 10),
      y: String(box.y + box.height / 2),
    });
    expect(await edit.json()).toEqual({ file: 'chapters/one.tex', line: 2, column: null });
  });

  test('bad input is 400 with a clear message', async () => {
    expect((await getSync('edit', { page: '1', x: 'a', y: '1' })).status).toBe(400);
    expect((await getSync('view', { line: '1' })).status).toBe(400);
    const notCompiled = await getSync('view', { file: 'main.tex', line: '1' });
    expect(notCompiled.status).toBe(400);
    expect(await notCompiled.json()).toEqual({
      error: 'main.pdf does not exist; compile first.',
    });
  });
});
