import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConflictError,
  listFiles,
  pageLines,
  readText,
  withFileLock,
  writeText,
  createDir,
  createFile,
  ExistsError,
  remove,
  rename,
  writeBinary,
} from '../fs.ts';
import { SAMPLES } from '../upload-samples.ts';
import { UploadError } from '../upload.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fs-test-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(path: string, content = ''): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}

describe('listFiles', () => {
  test('lists files and dirs recursively, sorted, skipping .git, node_modules and build artifacts', async () => {
    put('main.tex');
    put('refs.bib');
    put('main.pdf');
    put('chapters/intro.tex');
    put('chapters/b.tex');
    put('figures/plot.png');
    for (const ext of [
      'aux',
      'log',
      'fls',
      'fdb_latexmk',
      'synctex.gz',
      'out',
      'toc',
      'bbl',
      'blg',
    ]) {
      put(`main.${ext}`);
    }
    put('chapters/intro.aux');
    put('.git/HEAD');
    put('node_modules/x/index.js');
    put('sub/node_modules/y.js');
    put('.latex-agent/settings.json');
    put('.latex-agent/trash/2026/old.tex');
    put('data.zip');

    expect(await listFiles(root)).toEqual([
      { path: 'chapters', isDir: true },
      { path: 'chapters/b.tex', isDir: false, kind: 'text' },
      { path: 'chapters/intro.tex', isDir: false, kind: 'text' },
      { path: 'data.zip', isDir: false, kind: 'binary' },
      { path: 'figures', isDir: true },
      { path: 'figures/plot.png', isDir: false, kind: 'image' },
      { path: 'main.pdf', isDir: false, kind: 'pdf' },
      { path: 'main.tex', isDir: false, kind: 'text' },
      { path: 'refs.bib', isDir: false, kind: 'text' },
      { path: 'sub', isDir: true },
    ]);
  });

  test('a folder it may not read is listed empty instead of failing the listing', async () => {
    put('main.tex');
    put('private/secret.tex');
    chmodSync(join(root, 'private'), 0o000);
    try {
      expect(await listFiles(root)).toEqual([
        { path: 'main.tex', isDir: false, kind: 'text' },
        { path: 'private', isDir: true },
      ]);
    } finally {
      chmodSync(join(root, 'private'), 0o755);
    }
  });

  test('returns an empty list for an empty project', async () => {
    expect(await listFiles(root)).toEqual([]);
  });
});

describe('readText / writeText', () => {
  test('round-trips content and reports mtime', async () => {
    const { mtimeMs } = await writeText(root, 'a.tex', 'héllo');
    expect(await readText(root, 'a.tex')).toEqual({ content: 'héllo', mtimeMs });
  });

  test('creates parent directories', async () => {
    await writeText(root, 'deep/er/a.tex', 'x');
    expect(readFileSync(join(root, 'deep/er/a.tex'), 'utf8')).toBe('x');
  });

  test('rejects paths outside the project', async () => {
    await expect(readText(root, '../x')).rejects.toThrow('".."');
    await expect(writeText(root, '/tmp/x', 'x')).rejects.toThrow('relative');
  });

  test('writes when baseMtimeMs matches', async () => {
    const { mtimeMs } = await writeText(root, 'a.tex', 'v1');
    await writeText(root, 'a.tex', 'v2', mtimeMs);
    expect((await readText(root, 'a.tex')).content).toBe('v2');
  });

  test('throws ConflictError and keeps the file when it changed since baseMtimeMs', async () => {
    const { mtimeMs } = await writeText(root, 'a.tex', 'v1');
    writeFileSync(join(root, 'a.tex'), 'changed elsewhere');
    utimesSync(join(root, 'a.tex'), new Date(), new Date(mtimeMs + 5000));

    const error = await writeText(root, 'a.tex', 'v2', mtimeMs).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ path: 'a.tex' });
    expect((error as ConflictError).mtimeMs).toBeGreaterThan(mtimeMs + 4000);
    expect(readFileSync(join(root, 'a.tex'), 'utf8')).toBe('changed elsewhere');
  });

  test('throws ConflictError when the file was deleted since baseMtimeMs', async () => {
    const error = await writeText(root, 'gone.tex', 'v2', 123).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ mtimeMs: null });
  });
});

describe('withFileLock', () => {
  test('runs work on the same file in call order, one at a time', async () => {
    const events: string[] = [];
    const task = (name: string, ms: number) => () =>
      (async () => {
        events.push(`${name} start`);
        await Bun.sleep(ms);
        events.push(`${name} end`);
        return name;
      })();

    const results = await Promise.all([
      withFileLock('/p/a.tex', task('first', 30)),
      withFileLock('/p/a.tex', task('second', 1)),
      withFileLock('/p/./a.tex', task('third', 1)),
    ]);

    expect(results).toEqual(['first', 'second', 'third']);
    expect(events).toEqual([
      'first start',
      'first end',
      'second start',
      'second end',
      'third start',
      'third end',
    ]);
  });

  test('runs work on different files in parallel', async () => {
    const events: string[] = [];
    await Promise.all([
      withFileLock('/p/a.tex', async () => {
        events.push('a start');
        await Bun.sleep(30);
        events.push('a end');
      }),
      withFileLock('/p/b.tex', async () => {
        events.push('b start');
        events.push('b end');
      }),
    ]);
    expect(events).toEqual(['a start', 'b start', 'b end', 'a end']);
  });

  test('a failing task does not block the next one', async () => {
    const failed = withFileLock('/p/a.tex', async () => {
      throw new Error('boom');
    });
    const next = withFileLock('/p/a.tex', async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    expect(await next).toBe('ok');
  });

  test('two concurrent writeText calls to the same file land in order', async () => {
    await Promise.all([writeText(root, 'a.tex', 'first'), writeText(root, 'a.tex', 'second')]);
    expect(readFileSync(join(root, 'a.tex'), 'utf8')).toBe('second');
  });

  test('a stale concurrent save is rejected once the first one lands', async () => {
    const { mtimeMs } = await writeText(root, 'a.tex', 'v0');
    await Bun.sleep(5); // make sure the next write gets a different mtime
    const results = await Promise.allSettled([
      writeText(root, 'a.tex', 'from tab 1', mtimeMs),
      writeText(root, 'a.tex', 'from tab 2', mtimeMs),
    ]);
    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]?.status === 'rejected' && results[1].reason).toBeInstanceOf(ConflictError);
    expect(readFileSync(join(root, 'a.tex'), 'utf8')).toBe('from tab 1');
  });
});

describe('pageLines', () => {
  const readLines = async (root: string, path: string, offset?: number, limit?: number) =>
    pageLines((await readText(root, path)).content, path, offset, limit);

  const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

  test('returns a small file whole', async () => {
    put('a.tex', 'one\ntwo\nthree\n');
    expect(await readLines(root, 'a.tex')).toEqual({
      text: 'one\ntwo\nthree',
      totalLines: 3,
      truncated: false,
    });
  });

  test('counts a last line without a trailing newline, and handles CRLF', async () => {
    put('a.tex', 'one\r\ntwo');
    expect(await readLines(root, 'a.tex')).toMatchObject({ text: 'one\ntwo', totalLines: 2 });
  });

  test('handles an empty file', async () => {
    put('a.tex', '');
    expect(await readLines(root, 'a.tex')).toEqual({ text: '', totalLines: 0, truncated: false });
  });

  test('honours offset and limit, with a continuation hint', async () => {
    put('a.tex', numbered(10));
    expect(await readLines(root, 'a.tex', 3, 2)).toEqual({
      text: 'line 3\nline 4\n\n[truncated: 6 more lines, continue with offset=5]',
      totalLines: 10,
      truncated: true,
      nextOffset: 5,
    });
    expect(await readLines(root, 'a.tex', 9, 5)).toEqual({
      text: 'line 9\nline 10',
      totalLines: 10,
      truncated: false,
    });
  });

  test('caps at 2000 lines', async () => {
    put('a.tex', numbered(2500));
    const result = await readLines(root, 'a.tex');
    expect(result.truncated).toBe(true);
    expect(result.nextOffset).toBe(2001);
    expect(result.text.split('\n').slice(-3)).toEqual([
      'line 2000',
      '',
      '[truncated: 500 more lines, continue with offset=2001]',
    ]);
    expect((await readLines(root, 'a.tex', 2001)).truncated).toBe(false);
  });

  test('caps at 50 KB without cutting a line', async () => {
    const line = 'x'.repeat(999); // 1000 bytes with its newline
    put('a.tex', Array.from({ length: 60 }, () => line).join('\n'));
    const result = await readLines(root, 'a.tex');
    expect(result.nextOffset).toBe(52); // 51 lines = 51000 bytes <= 51200
    const body = result.text.split('\n\n[truncated')[0] ?? '';
    expect(body.split('\n').every((l) => l === line)).toBe(true);
    expect(result.text).toEndWith('[truncated: 9 more lines, continue with offset=52]');
  });

  test('counts bytes, not characters', async () => {
    const line = 'é'.repeat(500); // 1001 bytes with its newline
    put('a.tex', Array.from({ length: 60 }, () => line).join('\n'));
    expect((await readLines(root, 'a.tex')).nextOffset).toBe(52);
  });

  test('cuts a single line over 50 KB so the caller can move on', async () => {
    put('a.tex', `${'x'.repeat(60_000)}\nnext`);
    const result = await readLines(root, 'a.tex');
    expect(result.text).toStartWith(`${'x'.repeat(51_200)} [line 1 cut at 50 KB]`);
    expect(result.nextOffset).toBe(2);
  });

  test('rejects an offset past the end', async () => {
    put('a.tex', numbered(3));
    await expect(readLines(root, 'a.tex', 4)).rejects.toThrow('past the end');
    await expect(readLines(root, 'a.tex', 0)).rejects.toThrow('offset');
  });
});

describe('readText errors', () => {
  test('a missing file names the project path, not the absolute one, and keeps ENOENT', async () => {
    const error = (await readText(root, 'chapters/missing.tex').catch((e: unknown) => e)) as
      (Error & { code?: string }) | undefined;
    expect(error?.message).toBe('File not found: chapters/missing.tex');
    expect(error?.code).toBe('ENOENT');
    expect(error?.message).not.toContain(root);
  });

  test('a directory is refused with EISDIR', async () => {
    put('chapters/a.tex');
    const error = (await readText(root, 'chapters').catch((e: unknown) => e)) as Error & {
      code?: string;
    };
    expect(error).toMatchObject({ message: 'chapters is a directory, not a file', code: 'EISDIR' });
  });
});

describe('createFile / createDir', () => {
  test('creates files with parents and content, and empty folders', async () => {
    await createFile(root, 'chapters/intro.tex', '% !TEX root = ../main.tex\n');
    await createDir(root, 'figures/raw');
    expect(readFileSync(join(root, 'chapters/intro.tex'), 'utf8')).toBe(
      '% !TEX root = ../main.tex\n',
    );
    expect(statSync(join(root, 'figures/raw')).isDirectory()).toBe(true);
    await createFile(root, 'empty.tex');
    expect(readFileSync(join(root, 'empty.tex'), 'utf8')).toBe('');
  });

  test('never overwrites: ExistsError for an existing file or folder', async () => {
    put('main.tex', 'keep me');
    await expect(createFile(root, 'main.tex', 'x')).rejects.toBeInstanceOf(ExistsError);
    await expect(createDir(root, 'main.tex')).rejects.toBeInstanceOf(ExistsError);
    put('figures/a.png');
    await expect(createDir(root, 'figures')).rejects.toBeInstanceOf(ExistsError);
    expect(readFileSync(join(root, 'main.tex'), 'utf8')).toBe('keep me');
  });

  test('refuses app data and paths outside the project', async () => {
    await expect(createFile(root, '.latex-agent/x.tex')).rejects.toThrow('app');
    await expect(createDir(root, '../outside')).rejects.toThrow('..');
  });
});

describe('rename', () => {
  test('moves a file, creating the target folder', async () => {
    put('intro.tex', 'hi');
    await rename(root, 'intro.tex', 'chapters/intro.tex');
    expect(existsSync(join(root, 'intro.tex'))).toBe(false);
    expect(readFileSync(join(root, 'chapters/intro.tex'), 'utf8')).toBe('hi');
  });

  test('moves a folder with its contents', async () => {
    put('chapters/a.tex', 'a');
    await rename(root, 'chapters', 'parts');
    expect(readFileSync(join(root, 'parts/a.tex'), 'utf8')).toBe('a');
  });

  test('fails if the target exists, leaving both untouched', async () => {
    put('a.tex', 'A');
    put('b.tex', 'B');
    await expect(rename(root, 'a.tex', 'b.tex')).rejects.toBeInstanceOf(ExistsError);
    expect(readFileSync(join(root, 'a.tex'), 'utf8')).toBe('A');
    expect(readFileSync(join(root, 'b.tex'), 'utf8')).toBe('B');
  });

  test('fails for a missing source, a folder into itself, or the project root', async () => {
    await expect(rename(root, 'nope.tex', 'x.tex')).rejects.toMatchObject({ code: 'ENOENT' });
    put('chapters/a.tex');
    await expect(rename(root, 'chapters', 'chapters/sub')).rejects.toThrow('into itself');
    await expect(rename(root, '', 'x')).rejects.toThrow('project folder');
    await expect(rename(root, 'chapters', '.latex-agent/x')).rejects.toThrow('app');
  });

  test('a case-only rename works', async () => {
    put('Main.tex', 'M');
    await rename(root, 'Main.tex', 'main.tex');
    expect(readdirSync(root)).toContain('main.tex');
    expect(readFileSync(join(root, 'main.tex'), 'utf8')).toBe('M');
  });
});

describe('remove', () => {
  test('moves a file to .latex-agent/trash/<timestamp>/<path>, never deleting it', async () => {
    put('figures/old.png', 'png');
    const trashPath = await remove(root, 'figures/old.png');
    expect(trashPath).toMatch(
      /^\.latex-agent\/trash\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\/figures\/old\.png$/,
    );
    expect(existsSync(join(root, 'figures/old.png'))).toBe(false);
    expect(readFileSync(join(root, trashPath), 'utf8')).toBe('png');
  });

  test('moves a whole folder, and keeps two deletes of the same path', async () => {
    put('chapters/a.tex', 'one');
    const first = await remove(root, 'chapters');
    put('chapters/a.tex', 'two');
    const second = await remove(root, 'chapters');
    expect(first).not.toBe(second);
    expect(readFileSync(join(root, first, 'a.tex'), 'utf8')).toBe('one');
    expect(readFileSync(join(root, second, 'a.tex'), 'utf8')).toBe('two');
  });

  test('trash stays hidden from listFiles', async () => {
    put('a.tex');
    await remove(root, 'a.tex');
    expect(await listFiles(root)).toEqual([]);
  });

  test('fails for a missing path, the project root, or app data', async () => {
    await expect(remove(root, 'nope.tex')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(remove(root, '')).rejects.toThrow('project folder');
    await expect(remove(root, '.latex-agent')).rejects.toThrow('app');
  });
});

describe('writeBinary', () => {
  test('writes a valid upload, creating folders', async () => {
    expect(await writeBinary(root, 'figures/plot.png', SAMPLES.png)).toEqual({
      size: SAMPLES.png.byteLength,
    });
    expect(new Uint8Array(readFileSync(join(root, 'figures/plot.png')))).toEqual(SAMPLES.png);
  });

  test('refuses to overwrite unless replace, which trashes the old file', async () => {
    await writeBinary(root, 'plot.png', SAMPLES.png);
    await expect(writeBinary(root, 'plot.png', SAMPLES.png)).rejects.toBeInstanceOf(ExistsError);
    await writeBinary(root, 'plot.png', SAMPLES.png, { replace: true });
    const trash = join(root, '.latex-agent/trash');
    expect(readdirSync(trash)).toHaveLength(1);
  });

  test('rejects invalid uploads before touching the disk', async () => {
    await expect(writeBinary(root, 'fake.png', SAMPLES.jpg)).rejects.toBeInstanceOf(UploadError);
    await expect(writeBinary(root, 'notes.tex', SAMPLES.png)).rejects.toBeInstanceOf(UploadError);
    expect(readdirSync(root)).toEqual([]);
  });
});
