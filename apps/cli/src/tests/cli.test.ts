import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { logo, stripAnsi } from '../art.ts';
import { browserCommand, choosePort, openOnRunning, probe } from '../launch.ts';
import { parseArgs, projectFolder, UsageError } from '../main.ts';
import { render, step } from '../picker.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'phi-cli-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('arguments', () => {
  test('init and open take an optional path; options anywhere', () => {
    expect(parseArgs(['init'])).toEqual({ command: 'init', path: '.', template: null, open: true });
    expect(parseArgs(['init', 'thesis', '--template', 'thesis', '--no-open'])).toEqual({
      command: 'init',
      path: 'thesis',
      template: 'thesis',
      open: false,
    });
    expect(parseArgs(['--template=paper', 'init', '/a/b'])).toMatchObject({
      path: '/a/b',
      template: 'paper',
    });
    expect(parseArgs(['open', '../x']).command).toBe('open');
    expect(parseArgs([]).command).toBe('help');
    expect(parseArgs(['init', '-h']).command).toBe('help');
  });

  test('typos and extra words are usage errors', () => {
    for (const argv of [['int'], ['init', 'a', 'b'], ['init', '--nope'], ['init', '--template']]) {
      expect(() => parseArgs(argv)).toThrow(UsageError);
    }
  });
});

test('the home folder, the disk root and their parents are refused as projects', () => {
  for (const path of ['/Users/me', '/Users/me/', '/Users', '/']) {
    expect(() => projectFolder(path, '/Users/me')).toThrow('too broad to be a project');
  }
  expect(projectFolder('/Users/me/paper', '/Users/me')).toBe('/Users/me/paper');
  expect(projectFolder('/Users/meeting', '/Users/me')).toBe('/Users/meeting');
});

describe('picker', () => {
  test('arrows and j/k move and wrap; Enter or a number chooses; Esc, q and Ctrl+C cancel', () => {
    expect(step(0, 4, '\x1b[B')).toEqual({ index: 1 });
    expect(step(3, 4, 'j')).toEqual({ index: 0 });
    expect(step(0, 4, '\x1b[A')).toEqual({ index: 3 });
    expect(step(2, 4, 'k')).toEqual({ index: 1 });
    expect(step(2, 4, '\r')).toEqual({ chosen: 2 });
    expect(step(0, 4, '3')).toEqual({ chosen: 2 });
    expect(step(0, 4, '9')).toEqual({ index: 0 });
    for (const key of ['\x1b', '\x03', 'q']) expect(step(1, 4, key)).toEqual({ cancelled: true });
    expect(step(1, 4, 'x')).toEqual({ index: 1 });
  });

  test('renders the highlighted choice with a pointer', () => {
    const lines = render(
      'Pick',
      [{ label: 'Blank', hint: 'empty' }, { label: 'Thesis' }],
      1,
      false,
    );
    expect(lines).toEqual([
      '  Pick',
      '',
      '    1. Blank   empty',
      '  ❯ 2. Thesis',
      '',
      '  ↑/↓ move · Enter choose · Esc cancel',
    ]);
    const colored = render('Pick', [{ label: 'A' }], 0, true);
    expect(colored.map(stripAnsi)).toEqual(render('Pick', [{ label: 'A' }], 0, false));
  });
});

test('the logo: 12 lines, same shapes with and without color', () => {
  const colored = logo(true);
  expect(colored).toHaveLength(12);
  expect(colored[0]).toContain('\x1b[0;97m▄');
  expect(logo(false)[0]).toStartWith('▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄    ▄▄▄▄▄▄▄▄');
  expect(logo(false)).toEqual(colored.map(stripAnsi));
  expect(logo(false).join('')).not.toMatch(/\x1b|\\033|\\u/);
});

describe('finding a server', () => {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.stop(true);
  });
  const serve = (fetch: (req: Request) => Response | Promise<Response>) => {
    const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch });
    servers.push(s);
    return s.port as number;
  };

  test('tells Phi from other programs and from a free port', async () => {
    const phi = serve(() => Response.json({ ok: true, app: 'phi', projectRoot: null }));
    const other = serve(() => new Response('<html>'));
    expect(await probe(phi)).toBe('phi');
    expect(await probe(other)).toBe('taken');
    const free = serve(() => new Response());
    await servers.pop()!.stop(true);
    expect(await probe(free)).toBe('free');
  });

  test('skips ports held by other programs; reuses a running Phi', async () => {
    const other = serve(() => new Response('nginx'));
    const result = await choosePort(other, 3);
    expect(result.port).toBeGreaterThan(other);
    expect(result.running).toBe(false);
    const phi = serve(() => Response.json({ ok: true, app: 'phi', projectRoot: null }));
    expect(await choosePort(phi, 1)).toEqual({ port: phi, running: true });
    await expect(choosePort(other, 1)).rejects.toThrow('in use by other programs');
  });

  test('switching a running server: posts the path, surfaces its error', async () => {
    const posted: unknown[] = [];
    const port = serve(async (req) => {
      const body = (await req.json()) as { path: string };
      posted.push(body);
      return body.path === '/bad'
        ? Response.json({ error: '/bad does not exist' }, { status: 400 })
        : Response.json({ root: body.path, recent: [] });
    });
    await openOnRunning(port, '/good');
    expect(posted).toEqual([{ path: '/good' }]);
    await expect(openOnRunning(port, '/bad')).rejects.toThrow('/bad does not exist');
  });
});

test('browser opener per platform', () => {
  expect(browserCommand('http://x/', 'darwin')).toEqual(['open', 'http://x/']);
  expect(browserCommand('http://x/', 'linux')).toEqual(['xdg-open', 'http://x/']);
  expect(browserCommand('http://x/', 'win32')[0]).toBe('cmd');
});

test('end to end: phi init --template paper creates the project and serves it', async () => {
  const project = join(dir, 'my paper');
  const port = 41000 + Math.floor(Math.random() * 2000);
  const cli = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '../main.ts'),
      'init',
      project,
      '-t',
      'paper',
      '--no-open',
    ],
    {
      env: { ...process.env, PORT: String(port), HOME: dir, LLM_PROVIDER: 'faux', NO_COLOR: '1' },
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );
  try {
    let health: { app?: string; projectRoot?: string } | null = null;
    for (let i = 0; i < 200 && !health; i++) {
      health = await fetch(`http://127.0.0.1:${port}/api/health`)
        .then((r) => r.json() as Promise<{ app?: string; projectRoot?: string }>)
        .catch(() => null);
      if (!health) await Bun.sleep(100);
    }
    expect(health).toEqual({ ok: true, app: 'phi', projectRoot: project } as never);
    expect(readFileSync(join(project, 'references.bib'), 'utf8')).toContain('@article{example');
    const files = (await (await fetch(`http://127.0.0.1:${port}/api/files`)).json()) as {
      path: string;
    }[];
    expect(files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['main.tex', 'references.bib']),
    );
  } finally {
    cli.kill('SIGINT');
    await cli.exited;
  }
  // Ctrl+C stopped the server it started.
  expect(await probe(port)).toBe('free');
}, 30_000);
