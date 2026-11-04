import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import type { FileEntry, WireEvent } from '@phi/shared';

import { createLlm, type Llm } from '../agent/llm.ts';
import { createProjects, type Projects } from '../project.ts';
import { createSettingsStore, type SettingsStore } from '../services/settings.ts';

let dir: string;
let a: string;
let b: string;
let llm: Llm;
let settings: SettingsStore;
let projects: Projects;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'projects-test-'));
  a = join(dir, 'thesis');
  b = join(dir, 'paper');
  for (const [root, file] of [
    [a, 'thesis.tex'],
    [b, 'paper.tex'],
  ] as const) {
    mkdirSync(root);
    writeFileSync(join(root, file), '\\documentclass{article}\n');
  }
  llm = createLlm({ LLM_PROVIDER: 'faux' });
  settings = createSettingsStore(join(dir, 'home', 'settings.json'));
  projects = createProjects({ initialRoot: a, llm, settings });
});

afterEach(async () => {
  await projects
    .current()
    .threads.flush()
    .catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

const listFiles = async () => (await (await projects.current().files.list()).json()) as FileEntry[];

test('opening checks the path: absolute, existing, a folder', async () => {
  await expect(projects.open('relative/path')).rejects.toThrow('Use an absolute path');
  await expect(projects.open(join(dir, 'missing'))).rejects.toThrow('does not exist');
  await expect(projects.open(join(a, 'thesis.tex'))).rejects.toThrow('is not a folder');
  await expect(projects.open(undefined)).rejects.toThrow('"path" is required');
  expect(projects.root()).toBe(a);
});

test('switching: every handler serves the new root; recent projects are recorded', async () => {
  expect((await listFiles()).map((f) => f.path)).toEqual(['thesis.tex']);
  await projects.open(b);
  expect(projects.root()).toBe(b);
  expect((await listFiles()).map((f) => f.path)).toEqual(['paper.tex']);
  await projects.open(`${a}/`); // trailing slash: same folder
  expect(projects.root()).toBe(a);
  expect((await settings.read()).recentProjects).toEqual([a, b]);
});

test('onSwitch runs when another folder opens (the language servers close), not for the same one', async () => {
  let switches = 0;
  const watched = createProjects({ initialRoot: a, llm, settings, onSwitch: () => switches++ });
  await watched.open(`${a}/`);
  expect(switches).toBe(0);
  await watched.open(b);
  expect(switches).toBe(1);
  await expect(watched.open(join(dir, 'missing'))).rejects.toThrow();
  expect(switches).toBe(1);
});

test('switching stops the running agent, saves it, and starts with fresh threads', async () => {
  llm.faux?.setResponses([
    (_context, options) =>
      new Promise((resolve) => {
        if (options?.signal?.aborted) return resolve(fauxAssistantMessage('late'));
        options?.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('late')));
      }),
  ]);
  const before = projects.current();
  const thread = await before.threads.getOrCreateThread('t1');
  const events: WireEvent[] = [];
  thread.subscribe(0, (e) => events.push(e));
  thread.runner.start('Write a long chapter', 'm1');
  await Bun.sleep(30);
  expect(thread.runner.isRunning).toBe(true);

  await projects.open(b);
  expect(thread.runner.isRunning).toBe(false);
  expect(events).toContainEqual(expect.objectContaining({ type: 'run_end', reason: 'aborted' }));
  expect(projects.current().threads).not.toBe(before.threads);
  expect(await projects.current().threads.listThreads()).toEqual([]);

  // Back in the first project, its conversation was saved.
  await projects.open(a);
  const saved = await projects.current().threads.listThreads();
  expect(saved.map((t) => t.id)).toEqual(['t1']);
});

test('no project yet: routes answer 409 until one is opened', async () => {
  const empty = createProjects({ initialRoot: null, llm, settings });
  expect(empty.root()).toBeNull();
  expect(() => empty.current()).toThrow('No project is open');
  await empty.open(b);
  expect(empty.current().root).toBe(b);
  await empty.current().threads.flush();
});
