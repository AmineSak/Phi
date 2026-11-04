import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import type { SettingsResponse } from '@phi/shared';

import { createLlm, type Llm } from '../../agent/llm.ts';
import { createThreads } from '../../agent/threads.ts';
import { createSettingsStore, type SettingsStore } from '../../services/settings.ts';
import { guard } from '../security.ts';
import { settingsHandlers } from '../settings.ts';
import { tempProject } from './test-project.ts';

let dir: string;
let settings: SettingsStore;
let server: ReturnType<typeof Bun.serve>;
let url: string;

function serve(llm: Llm) {
  const handlers = settingsHandlers(llm, settings);
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = server.port ?? 0;
  url = `http://127.0.0.1:${port}/api/settings`;
  server.reload({
    routes: { '/api/settings': { GET: guard(handlers.get, port), PUT: guard(handlers.put, port) } },
    fetch: () => new Response('Not found', { status: 404 }),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'settings-route-'));
  settings = createSettingsStore(join(dir, 'settings.json'));
});

afterEach(async () => {
  await server?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const put = (body: unknown) =>
  fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('GET: model, catalog and key status; the key itself is never sent', async () => {
  serve(createLlm({}, settings));
  let body = (await (await fetch(url)).json()) as SettingsResponse;
  expect(body).toMatchObject({
    provider: 'openrouter',
    model: 'openrouter/free',
    modelSource: 'default',
    apiKeyConfigured: false,
    apiKeyHint: null,
    apiKeySource: null,
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
  });
  expect(body.models.length).toBeGreaterThan(10);

  const res = await put({ apiKey: 'sk-or-v1-secret-a1b2' });
  body = (await res.json()) as SettingsResponse;
  expect(body).toMatchObject({
    apiKeyConfigured: true,
    apiKeyHint: '…a1b2',
    apiKeySource: 'settings',
  });
  expect(JSON.stringify(body)).not.toContain('secret');
  expect(JSON.stringify(await (await fetch(url)).json())).not.toContain('secret');
  // Stored server-side, readable by the user only.
  expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).apiKeys.openrouter).toBe(
    'sk-or-v1-secret-a1b2',
  );

  body = (await (await put({ apiKey: '' })).json()) as SettingsResponse;
  expect(body.apiKeyConfigured).toBe(false);
});

test('PUT model: must be in the catalog; "" goes back to the default', async () => {
  serve(createLlm({ OPENROUTER_API_KEY: 'k' }, settings));
  expect((await put({ model: 'not/a-model' })).status).toBe(400);
  expect((await put({ model: 7 })).status).toBe(400);
  let body = (await (await put({ model: 'openrouter/auto' })).json()) as SettingsResponse;
  expect(body).toMatchObject({ model: 'openrouter/auto', modelSource: 'settings' });
  body = (await (await put({ model: '' })).json()) as SettingsResponse;
  expect(body).toMatchObject({ model: 'openrouter/free', modelSource: 'default' });
});

test('the environment wins, and GET says so', async () => {
  await settings.setModel('openrouter', 'openrouter/auto');
  await settings.setApiKey('openrouter', 'stored-key-9999');
  serve(createLlm({ LLM_MODEL: 'openrouter/free', OPENROUTER_API_KEY: 'env-key-1234' }, settings));
  expect(await (await fetch(url)).json()).toMatchObject({
    model: 'openrouter/free',
    modelSource: 'env',
    apiKeyHint: '…1234',
    apiKeySource: 'env',
  });
});

test('a model and key changed in Settings apply to the next run, without a restart', async () => {
  const project = tempProject();
  try {
    const llm = createLlm({}, settings);
    // Answer through a faux provider, recording what each request was sent with.
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const seen: { model: string; apiKey?: string }[] = [];
    const recording: StreamFn = (model, context, options) => {
      seen.push({ model: model.id, apiKey: options?.apiKey });
      return models.streamSimple(faux.getModel(), context, options);
    };
    const threads = createThreads({
      projectRoot: project.root,
      llm: { ...llm, streamFn: recording },
    });
    const thread = await threads.getOrCreateThread('t1');

    await settings.setApiKey('openrouter', 'first-key');
    faux.setResponses([fauxAssistantMessage('one')]);
    thread.runner.start('hello', 'm1');
    await thread.runner.whenIdle();

    await settings.setModel('openrouter', 'openrouter/auto');
    await settings.setApiKey('openrouter', 'second-key');
    faux.setResponses([fauxAssistantMessage('two')]);
    thread.runner.start('again', 'm2');
    await thread.runner.whenIdle();

    expect(seen).toEqual([
      { model: 'openrouter/free', apiKey: 'first-key' },
      { model: 'openrouter/auto', apiKey: 'second-key' },
    ]);
    // The assistant message records the model it was asked to be.
    expect(thread.agent.state.model.id).toBe('openrouter/auto');
    await threads.flush();
  } finally {
    project.remove();
  }
});

test('a provider that needs no key counts as configured (no setup card)', async () => {
  serve(createLlm({ LLM_PROVIDER: 'faux' }, settings));
  expect(await (await fetch(url)).json()).toMatchObject({
    provider: 'faux',
    providerSource: 'env',
    providers: [],
    apiKeyConfigured: true,
    apiKeyHint: null,
    apiKeyEnvVar: '',
  });
});

test('GET lists the four providers with their key state, default model and key URL', async () => {
  await settings.setApiKey('anthropic', 'sk-ant-secret-wxyz');
  serve(createLlm({ OPENAI_API_KEY: 'sk-env-0000' }, settings));
  const body = (await (await fetch(url)).json()) as SettingsResponse;
  expect(body.providerSource).toBe('default');
  expect(
    body.providers.map((p) => [p.id, p.name, p.keyConfigured, p.keyHint, p.keySource]),
  ).toEqual([
    ['openrouter', 'OpenRouter', false, null, null],
    ['anthropic', 'Claude', true, '…wxyz', 'settings'],
    ['openai', 'OpenAI', true, '…0000', 'env'],
    ['mistral', 'Mistral', false, null, null],
  ]);
  expect(body.providers[1]).toMatchObject({
    vendor: 'Anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-5-5',
    keyUrl: expect.stringContaining('anthropic.com'),
  });
  for (const p of body.providers) expect(p.modelCount).toBeGreaterThan(5);
  expect(JSON.stringify(body)).not.toContain('secret');
});

test('switching providers: keys stay per provider; model and key apply to the active one', async () => {
  serve(createLlm({}, settings));
  // Keys for several providers in one request; the active one doesn't change.
  let body = (await (
    await put({ apiKeys: { anthropic: 'sk-ant-1111', mistral: 'mist-2222' } })
  ).json()) as SettingsResponse;
  expect(body.provider).toBe('openrouter');
  expect(body.apiKeyConfigured).toBe(false);

  body = (await (await put({ provider: 'anthropic' })).json()) as SettingsResponse;
  expect(body).toMatchObject({
    provider: 'anthropic',
    providerSource: 'settings',
    model: 'claude-sonnet-5-5',
    modelSource: 'default',
    apiKeyConfigured: true,
    apiKeyHint: '…1111',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  });
  expect(body.models.some((m) => m.id === 'claude-opus-5-5')).toBe(true);

  // Switch and pick a model in one go; the model must be in the new provider's catalog.
  expect((await put({ provider: 'mistral', model: 'claude-opus-5-5' })).status).toBe(400);
  body = (await (
    await put({ provider: 'mistral', model: 'mistral-small-latest' })
  ).json()) as SettingsResponse;
  expect(body).toMatchObject({ provider: 'mistral', model: 'mistral-small-latest' });

  // Back to Claude: its own model choice was kept apart.
  body = (await (await put({ provider: 'anthropic' })).json()) as SettingsResponse;
  expect(body.model).toBe('claude-sonnet-5-5');
  expect(body.providers.find((p) => p.id === 'mistral')?.model).toBe('mistral-small-latest');

  // A key can be removed without switching.
  body = (await (await put({ apiKeys: { anthropic: '' } })).json()) as SettingsResponse;
  expect(body.apiKeyConfigured).toBe(false);
});

test('bad provider updates are refused; LLM_PROVIDER pins the provider', async () => {
  serve(createLlm({}, settings));
  expect((await put({ provider: 'gemini' })).status).toBe(400);
  expect((await put({ apiKeys: { gemini: 'x' } })).status).toBe(400);
  expect((await put({ apiKeys: { openai: 3 } })).status).toBe(400);
  expect((await put({ apiKeys: 'x' })).status).toBe(400);
  await server.stop(true);

  serve(createLlm({ LLM_PROVIDER: 'openai' }, settings));
  const res = await put({ provider: 'anthropic' });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: 'LLM_PROVIDER in the .env file sets the provider' });
  // Keys and models of the pinned provider still can be set.
  const body = (await (
    await put({ provider: 'openai', apiKey: 'sk-proj-abcd', model: 'gpt-5.4-mini' })
  ).json()) as SettingsResponse;
  expect(body).toMatchObject({
    provider: 'openai',
    providerSource: 'env',
    model: 'gpt-5.4-mini',
    apiKeyHint: '…abcd',
  });
});

test("a run uses the active provider's key: switching applies from the next request", async () => {
  const llm = createLlm({}, settings);
  await settings.setApiKey('openrouter', 'or-key');
  await settings.setApiKey('anthropic', 'ant-key');
  expect(await llm.apiKey()).toBe('or-key');
  await settings.setProvider('anthropic');
  expect(await llm.apiKey()).toBe('ant-key');
  // pi asks by the model's provider: a request already resolved keeps its own key.
  expect(await llm.apiKey('openrouter')).toBe('or-key');
  expect((await llm.resolve()).model).toMatchObject({
    id: 'claude-sonnet-5-5',
    provider: 'anthropic',
  });
});
