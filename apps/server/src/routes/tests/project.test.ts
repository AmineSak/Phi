import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProjectResponse, ProjectsResponse, TemplateInfo } from '@phi/shared';
import { unzipSync } from 'fflate';

import { createLlm } from '../../agent/llm.ts';
import { createProjects, type Projects } from '../../project.ts';
import { createSettingsStore } from '../../services/settings.ts';
import { projectHandlers } from '../project.ts';

let dir: string;
let projectsDir: string;
let made: Projects[];

/** The handlers of a server whose projects live in `projectsDir` (deployed) or anywhere. */
function handlers(managed: boolean, initialRoot: string | null = null) {
  const settings = createSettingsStore(join(dir, 'home', 'settings.json'));
  const projects = createProjects({
    initialRoot,
    llm: createLlm({ LLM_PROVIDER: 'faux' }),
    settings,
    projectsDir: managed ? projectsDir : null,
  });
  made.push(projects);
  return { api: projectHandlers(projects, settings), projects };
}

const post = (body: unknown) =>
  new Request('http://127.0.0.1:3000/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'project-routes-'));
  projectsDir = join(dir, 'projects');
  mkdirSync(projectsDir);
  made = [];
});

afterEach(async () => {
  for (const p of made)
    if (p.root())
      await p
        .current()
        .threads.flush()
        .catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

test('templates: the bundled four, without their folders', async () => {
  const list = (await handlers(false).api.templates().json()) as TemplateInfo[];
  expect(list.map((t) => t.id)).toEqual(['blank', 'beamer', 'paper', 'thesis']);
  expect(list[2]).toEqual({
    id: 'paper',
    name: 'Scientific paper',
    description: expect.any(String),
  });
});

describe('locally (SPEC 4.4)', () => {
  test('projects are opened by folder: not managed, no list, no creation', async () => {
    const { api } = handlers(false);
    expect(((await (await api.get()).json()) as ProjectResponse).managed).toBe(false);
    await expect(api.list()).rejects.toMatchObject({ status: 404 });
    await expect(api.create(post({ name: 'x', template: 'blank' }))).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('deployed (SPEC 9.2)', () => {
  test('lists the project folders by name, hidden ones and files left out', async () => {
    for (const name of ['thesis', 'a paper', '.trash']) mkdirSync(join(projectsDir, name));
    writeFileSync(join(projectsDir, 'notes.txt'), '');
    const { api } = handlers(true);
    expect(((await (await api.get()).json()) as ProjectResponse).managed).toBe(true);
    expect(((await (await api.list()).json()) as ProjectsResponse).projects).toEqual([
      { name: 'a paper', path: join(projectsDir, 'a paper') },
      { name: 'thesis', path: join(projectsDir, 'thesis') },
    ]);
  });

  test('creating a project copies the template and opens it', async () => {
    const { api, projects } = handlers(true);
    const res = await api.create(post({ name: ' My Paper ', template: 'paper' }));
    expect(res.status).toBe(201);
    const path = join(projectsDir, 'My Paper');
    expect(((await res.json()) as ProjectResponse).root).toBe(path);
    expect(projects.root()).toBe(path);
    expect(await Bun.file(join(path, 'references.bib')).exists()).toBe(true);
  });

  test('bad names, unknown templates and existing projects are refused', async () => {
    const { api } = handlers(true);
    for (const name of ['', '../escape', 'a/b', '.hidden', 'x'.repeat(65), 7]) {
      await expect(api.create(post({ name, template: 'blank' }))).rejects.toMatchObject({
        status: 400,
      });
    }
    await expect(api.create(post({ name: 'ok', template: 'nope' }))).rejects.toMatchObject({
      status: 400,
    });
    mkdirSync(join(projectsDir, 'taken'));
    await expect(api.create(post({ name: 'taken', template: 'blank' }))).rejects.toMatchObject({
      status: 409,
    });
  });
});

test('archive: the open project as a .zip, without app data or files outside it', async () => {
  const root = join(projectsDir, 'thesis');
  mkdirSync(join(root, 'chapters'), { recursive: true });
  mkdirSync(join(root, '.latex-agent', 'threads'), { recursive: true });
  writeFileSync(join(root, 'main.tex'), '\\documentclass{article}');
  writeFileSync(join(root, 'chapters', 'intro.tex'), 'Intro');
  writeFileSync(join(root, 'main.aux'), 'build output');
  writeFileSync(join(root, '.latex-agent', 'threads', 't.jsonl'), 'private');
  const secret = join(dir, 'secret.txt');
  writeFileSync(secret, 'not yours');
  symlinkSync(secret, join(root, 'leak.txt'));

  const res = await handlers(true, root).api.archive();
  expect(res.headers.get('content-type')).toBe('application/zip');
  expect(res.headers.get('content-disposition')).toBe('attachment; filename="thesis.zip"');
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  expect(Object.keys(files).sort()).toEqual(['chapters/intro.tex', 'main.tex']);
  expect(new TextDecoder().decode(files['chapters/intro.tex'])).toBe('Intro');
});
