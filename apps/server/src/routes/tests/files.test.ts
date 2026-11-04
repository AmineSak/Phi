import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { FileEntry, ReadFileResponse, WriteFileResponse } from '@phi/shared';

import { MAX_UPLOAD_BYTES } from '@phi/shared';

import { SAMPLES } from '../../services/upload-samples.ts';
import { fileHandlers } from '../files.ts';
import { guard } from '../security.ts';
import { BASE, tempProject } from './test-project.ts';

let project: ReturnType<typeof tempProject>;
let files: ReturnType<typeof fileHandlers>;

beforeEach(() => {
  project = tempProject();
  files = fileHandlers(project.root);
});

afterEach(() => project.remove());

const read = (path: string) => guard(files.read, 3000)(new Request(`${BASE}/api/files/${path}`));
const write = (path: string, body: unknown) =>
  guard(
    files.write,
    3000,
  )(
    new Request(`${BASE}/api/files/${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

test('GET /api/files lists the project', async () => {
  const res = await guard(files.list, 3000)(new Request(`${BASE}/api/files`));
  expect(res.status).toBe(200);
  expect((await res.json()) as FileEntry[]).toEqual([
    { path: 'main.tex', isDir: false, kind: 'text' },
  ]);
});

describe('GET /api/files/*', () => {
  test('returns content and mtime', async () => {
    const res = await read('main.tex');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReadFileResponse;
    expect(body.path).toBe('main.tex');
    expect(body.content).toContain('\\documentclass{article}');
    expect(body.mtimeMs).toBeGreaterThan(0);
  });

  test('decodes URL-encoded nested paths', async () => {
    await write('my%20chapters/intro%C3%A9.tex', { content: 'x' });
    expect(readFileSync(join(project.root, 'my chapters', 'introé.tex'), 'utf8')).toBe('x');
    expect((await read('my%20chapters/intro%C3%A9.tex')).status).toBe(200);
  });

  test('404 for a missing file', async () => {
    const res = await read('nope.tex');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'File not found: nope.tex' });
  });

  test('400 for traversal, encoded traversal, symlink escapes and directories', async () => {
    symlinkSync('/etc/hosts', join(project.root, 'hosts'));
    await write('dir/a.tex', { content: '' });
    for (const path of [
      '..%2F..%2Fetc%2Fpasswd',
      '%2Fetc%2Fpasswd',
      'hosts',
      'a%00.tex',
      'dir',
      '%E0%A4%A',
    ]) {
      expect({ path, status: (await read(path)).status }).toEqual({ path, status: 400 });
    }
  });

  test('URL-normalised traversal never leaves the API prefix', async () => {
    // new URL() resolves "/api/files/../../x" to "/x", which the router would not send here.
    expect(new URL(`${BASE}/api/files/../../etc/passwd`).pathname).toBe('/etc/passwd');
  });
});

describe('PUT /api/files/*', () => {
  test('writes and returns the new mtime', async () => {
    const res = await write('main.tex', { content: 'new content' });
    expect(res.status).toBe(200);
    const { mtimeMs } = (await res.json()) as WriteFileResponse;
    expect(readFileSync(join(project.root, 'main.tex'), 'utf8')).toBe('new content');
    expect(((await (await read('main.tex')).json()) as ReadFileResponse).mtimeMs).toBe(mtimeMs);
  });

  test('accepts a matching baseMtimeMs and 409s on a stale one', async () => {
    const { mtimeMs } = (await (await read('main.tex')).json()) as ReadFileResponse;
    expect((await write('main.tex', { content: 'v2', baseMtimeMs: mtimeMs })).status).toBe(200);

    const stale = await write('main.tex', { content: 'v3', baseMtimeMs: mtimeMs });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { error: string; path: string; mtimeMs: number };
    expect(body).toMatchObject({ error: 'conflict', path: 'main.tex' });
    expect(body.mtimeMs).not.toBe(mtimeMs);
    expect(readFileSync(join(project.root, 'main.tex'), 'utf8')).toBe('v2');
  });

  test('400 for invalid bodies', async () => {
    expect((await write('a.tex', { content: 42 })).status).toBe(400);
    expect((await write('a.tex', { content: 'x', baseMtimeMs: 'yesterday' })).status).toBe(400);
    expect((await write('a.tex', null)).status).toBe(400);
    const notJson = await guard(
      files.write,
      3000,
    )(new Request(`${BASE}/api/files/a.tex`, { method: 'PUT', body: 'not json' }));
    expect(notJson.status).toBe(400);
  });

  test('400 when writing outside the project', async () => {
    expect((await write('..%2Fescape.tex', { content: 'x' })).status).toBe(400);
  });
});

type Handler = (req: Request) => Response | Promise<Response>;

/** Calls a handler through the guard, like the server does. */
function call(
  handler: Handler,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const init: RequestInit = { method, headers };
  if (body instanceof Uint8Array) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json', ...headers };
  }
  return guard(handler, 3000)(new Request(`${BASE}${path}`, init));
}

const disk = (path: string) => join(project.root, path);

describe('POST /api/files (create)', () => {
  test('creates a file with content and its folders (201)', async () => {
    const res = await call(files.create, 'POST', '/api/files', {
      path: 'chapters/intro.tex',
      type: 'file',
      content: '% !TEX root = ../main.tex\n',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ path: 'chapters/intro.tex' });
    expect(readFileSync(disk('chapters/intro.tex'), 'utf8')).toBe('% !TEX root = ../main.tex\n');
  });

  test('creates an empty folder', async () => {
    expect(
      (await call(files.create, 'POST', '/api/files', { path: 'figures', type: 'dir' })).status,
    ).toBe(201);
    expect(readdirSync(disk('figures'))).toEqual([]);
  });

  test('409 exists for a file or folder already there, which is left untouched', async () => {
    const res = await call(files.create, 'POST', '/api/files', {
      path: 'main.tex',
      type: 'file',
      content: 'x',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'exists', path: 'main.tex' });
    expect(readFileSync(disk('main.tex'), 'utf8')).toContain('documentclass');
  });

  test('400 for bad bodies, traversal and app data', async () => {
    expect(
      (await call(files.create, 'POST', '/api/files', { path: 'a.tex', type: 'link' })).status,
    ).toBe(400);
    expect((await call(files.create, 'POST', '/api/files', { type: 'file' })).status).toBe(400);
    expect(
      (await call(files.create, 'POST', '/api/files', { path: '../x.tex', type: 'file' })).status,
    ).toBe(400);
    expect(
      (await call(files.create, 'POST', '/api/files', { path: '.latex-agent/x', type: 'dir' }))
        .status,
    ).toBe(400);
  });
});

describe('POST /api/files/rename', () => {
  test('moves a file into a new folder', async () => {
    const res = await call(files.rename, 'POST', '/api/files/rename', {
      from: 'main.tex',
      to: 'paper/main.tex',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ from: 'main.tex', to: 'paper/main.tex' });
    expect(existsSync(disk('main.tex'))).toBe(false);
    expect(existsSync(disk('paper/main.tex'))).toBe(true);
  });

  test('409 when the target exists; 404 for a missing source; 400 for bad input', async () => {
    writeFileSync(disk('other.tex'), 'other');
    expect(
      (await call(files.rename, 'POST', '/api/files/rename', { from: 'main.tex', to: 'other.tex' }))
        .status,
    ).toBe(409);
    expect(readFileSync(disk('other.tex'), 'utf8')).toBe('other');
    expect(
      (await call(files.rename, 'POST', '/api/files/rename', { from: 'nope.tex', to: 'x.tex' }))
        .status,
    ).toBe(404);
    expect(
      (await call(files.rename, 'POST', '/api/files/rename', { from: 'main.tex' })).status,
    ).toBe(400);
    expect(
      (await call(files.rename, 'POST', '/api/files/rename', { from: 'main.tex', to: '../x.tex' }))
        .status,
    ).toBe(400);
  });
});

describe('DELETE /api/files/*', () => {
  test('moves the file to .latex-agent/trash and says where', async () => {
    const res = await call(files.remove, 'DELETE', '/api/files/main.tex');
    expect(res.status).toBe(200);
    const { trashPath } = (await res.json()) as { trashPath: string };
    expect(trashPath).toMatch(/^\.latex-agent\/trash\/.+\/main\.tex$/);
    expect(existsSync(disk('main.tex'))).toBe(false);
    expect(readFileSync(disk(trashPath), 'utf8')).toContain('documentclass');
  });

  test('a folder goes to the trash whole; 404 when missing; 400 for app data', async () => {
    mkdirSync(disk('chapters'));
    writeFileSync(disk('chapters/a.tex'), 'a');
    expect((await call(files.remove, 'DELETE', '/api/files/chapters')).status).toBe(200);
    expect((await call(files.remove, 'DELETE', '/api/files/nope.tex')).status).toBe(404);
    expect((await call(files.remove, 'DELETE', '/api/files/.latex-agent')).status).toBe(400);
  });
});

describe('POST /api/upload/*', () => {
  test('accepts each allowed type (201) and reports its kind and size', async () => {
    for (const [path, data, kind] of [
      ['figures/plot.png', SAMPLES.png, 'image'],
      ['photo.jpg', SAMPLES.jpg, 'image'],
      ['figures/diagram.pdf', SAMPLES.pdf, 'pdf'],
      ['fig.eps', SAMPLES.eps, 'image'],
      ['logo.svg', SAMPLES.svg, 'image'],
    ] as const) {
      const res = await call(files.upload, 'POST', `/api/upload/${path}`, data);
      expect({ path, status: res.status }).toEqual({ path, status: 201 });
      expect(await res.json()).toEqual({ path, kind, size: data.byteLength });
    }
    expect(new Uint8Array(readFileSync(disk('figures/plot.png')))).toEqual(SAMPLES.png);
  });

  test('409 for an existing file unless ?replace=1, which trashes the old one', async () => {
    await call(files.upload, 'POST', '/api/upload/plot.png', SAMPLES.png);
    const again = await call(files.upload, 'POST', '/api/upload/plot.png', SAMPLES.png);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'exists', path: 'plot.png' });
    expect(
      (await call(files.upload, 'POST', '/api/upload/plot.png?replace=1', SAMPLES.png)).status,
    ).toBe(201);
    expect(readdirSync(disk('.latex-agent/trash'))).toHaveLength(1);
  });

  test('rejected uploads: type, content, svg, size, and app data', async () => {
    const reject = async (path: string, data: Uint8Array, status: number, message: RegExp) => {
      const res = await call(files.upload, 'POST', `/api/upload/${path}`, data);
      expect({ path, status: res.status }).toEqual({ path, status });
      expect(((await res.json()) as { error: string }).error).toMatch(message);
      expect(existsSync(disk(path))).toBe(false);
    };
    await reject('notes.tex', SAMPLES.png, 400, /Only png, jpg, jpeg, pdf, eps, svg/);
    await reject('script.html', SAMPLES.svg, 400, /Only/);
    await reject('fake.png', SAMPLES.jpg, 400, /not a valid \.png/);
    await reject('fake.pdf', SAMPLES.png, 400, /not a valid \.pdf/);
    await reject(
      'page.svg',
      new TextEncoder().encode('<html><body/></html>'),
      400,
      /does not start with an <svg>/,
    );
    await reject('broken.svg', new TextEncoder().encode('<svg><g></svg>'), 400, /not well-formed/);
    const huge = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    huge.set(SAMPLES.png);
    await reject('huge.png', huge, 413, /20 MB/);
    const res = await call(files.upload, 'POST', '/api/upload/.latex-agent/x.png', SAMPLES.png);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/raw/*', () => {
  test('serves bytes with the right Content-Type, uncached and sandboxed', async () => {
    await call(files.upload, 'POST', '/api/upload/figures/plot.png', SAMPLES.png);
    await call(files.upload, 'POST', '/api/upload/logo.svg', SAMPLES.svg);
    await call(files.upload, 'POST', '/api/upload/doc.pdf', SAMPLES.pdf);
    for (const [path, type] of [
      ['figures/plot.png', 'image/png'],
      ['logo.svg', 'image/svg+xml'],
      ['doc.pdf', 'application/pdf'],
      ['main.tex', 'text/plain; charset=utf-8'],
    ] as const) {
      const res = await call(files.raw, 'GET', `/api/raw/${path}`);
      expect({ path, status: res.status, type: res.headers.get('content-type') }).toEqual({
        path,
        status: 200,
        type,
      });
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toContain('sandbox');
    }
    const png = await call(files.raw, 'GET', '/api/raw/figures/plot.png');
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(SAMPLES.png);
  });

  test('404 when missing; 400 for traversal and app data', async () => {
    expect((await call(files.raw, 'GET', '/api/raw/nope.png')).status).toBe(404);
    expect((await call(files.raw, 'GET', '/api/raw/..%2Fetc%2Fpasswd')).status).toBe(400);
    mkdirSync(disk('.latex-agent'));
    writeFileSync(disk('.latex-agent/settings.json'), '{}');
    expect((await call(files.raw, 'GET', '/api/raw/.latex-agent/settings.json')).status).toBe(400);
  });
});

describe('text-only routes and hidden app data', () => {
  test('GET /api/files/* refuses non-text files', async () => {
    await call(files.upload, 'POST', '/api/upload/plot.png', SAMPLES.png);
    const res = await read('plot.png');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('not a text file');
  });

  test('GET /api/files hides .latex-agent and its trash', async () => {
    await call(files.remove, 'DELETE', '/api/files/main.tex');
    const res = await guard(files.list, 3000)(new Request(`${BASE}/api/files`));
    expect(await res.json()).toEqual([]);
  });
});
