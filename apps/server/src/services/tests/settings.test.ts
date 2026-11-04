import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSettingsStore, MAX_RECENT_PROJECTS, SettingsError } from '../settings.ts';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'settings-test-'));
  path = join(dir, '.latex-agent', 'settings.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('defaults when the file is missing', async () => {
  expect(await createSettingsStore(path).read()).toEqual({
    apiKeys: {},
    models: {},
    recentProjects: [],
  });
});

test('writes are readable by the user only (0600) and survive a new store', async () => {
  const store = createSettingsStore(path);
  await store.setApiKey('openrouter', 'sk-or-secret-1234');
  await store.setApiKey('anthropic', 'sk-ant-5678');
  await store.setModel('openrouter', 'openrouter/auto');
  await store.setProvider('anthropic');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, '.latex-agent')).mode & 0o777).toBe(0o700);
  expect(await createSettingsStore(path).read()).toEqual({
    provider: 'anthropic',
    apiKeys: { openrouter: 'sk-or-secret-1234', anthropic: 'sk-ant-5678' },
    models: { openrouter: 'openrouter/auto' },
    recentProjects: [],
  });
});

test('an empty value removes the key or model', async () => {
  const store = createSettingsStore(path);
  await store.setApiKey('openai', 'k');
  await store.setApiKey('mistral', 'k2');
  await store.setModel('openai', 'm');
  await store.setProvider('openai');
  await store.setApiKey('openai', '');
  await store.setModel('openai', undefined);
  await store.setProvider(undefined);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
    apiKeys: { mistral: 'k2' },
    models: {},
    recentProjects: [],
  });
});

test('recent projects: most recent first, no duplicates, at most 10', async () => {
  const store = createSettingsStore(path);
  for (let i = 0; i < 12; i++) await store.addRecentProject(`/p/${i}`);
  await store.addRecentProject('/p/5');
  const { recentProjects } = await store.read();
  expect(recentProjects[0]).toBe('/p/5');
  expect(recentProjects).toHaveLength(MAX_RECENT_PROJECTS);
  expect(new Set(recentProjects).size).toBe(MAX_RECENT_PROJECTS);
});

test('concurrent updates all land', async () => {
  const store = createSettingsStore(path);
  await Promise.all([
    store.setApiKey('openai', 'k'),
    store.setApiKey('mistral', 'k2'),
    store.setModel('openai', 'm'),
    store.addRecentProject('/a'),
  ]);
  expect(await createSettingsStore(path).read()).toEqual({
    apiKeys: { openai: 'k', mistral: 'k2' },
    models: { openai: 'm' },
    recentProjects: ['/a'],
  });
});

test('invalid JSON is a clear error; unknown fields are ignored', async () => {
  mkdirSync(join(dir, '.latex-agent'));
  writeFileSync(path, '{ nope');
  await expect(createSettingsStore(path).read()).rejects.toThrow(SettingsError);
  writeFileSync(
    path,
    JSON.stringify({
      provider: 'nope',
      apiKeys: { openai: 'k', bogus: 'x', mistral: 3 },
      recentProjects: ['/a', 3],
      extra: true,
    }),
  );
  expect(await createSettingsStore(path).read()).toEqual({
    apiKeys: { openai: 'k' },
    models: {},
    recentProjects: ['/a'],
  });
});

test("a file from before providers: its one key and model become OpenRouter's", async () => {
  mkdirSync(join(dir, '.latex-agent'));
  writeFileSync(path, JSON.stringify({ apiKey: 'sk-or-old', model: 'openrouter/auto' }));
  const store = createSettingsStore(path);
  expect(await store.read()).toEqual({
    apiKeys: { openrouter: 'sk-or-old' },
    models: { openrouter: 'openrouter/auto' },
    recentProjects: [],
  });
  // The next write stores the new shape only.
  await store.setApiKey('anthropic', 'sk-ant');
  const written = JSON.parse(readFileSync(path, 'utf8'));
  expect(written.apiKey).toBeUndefined();
  expect(written.apiKeys).toEqual({ openrouter: 'sk-or-old', anthropic: 'sk-ant' });
});
