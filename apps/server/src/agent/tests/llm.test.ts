import { expect, test } from 'bun:test';

import type { GlobalSettings } from '../../services/settings.ts';
import { createLlm } from '../llm.ts';

const KEY = { OPENROUTER_API_KEY: 'test-key' };

/** A settings file in memory; tests change it between calls, as the Settings panel would. */
function settings(initial: Partial<GlobalSettings> = {}) {
  const value: GlobalSettings = { apiKeys: {}, models: {}, recentProjects: [], ...initial };
  return { value, read: async () => value };
}

test('defaults to OpenRouter with openrouter/free, thinking a little (reasoning is mandatory there)', async () => {
  const llm = createLlm(KEY);
  expect(llm.model).toMatchObject({ id: 'openrouter/free', provider: 'openrouter' });
  const { model, thinkingLevel, source } = await llm.resolve();
  expect(model.id).toBe('openrouter/free');
  expect(model.reasoning).toBe(true);
  expect(thinkingLevel).toBe('low');
  expect(source).toBe('default');
});

test('the model: LLM_MODEL wins over Settings, which wins over the default; read on every resolve', async () => {
  const stored = settings();
  const llm = createLlm(KEY, stored);
  expect((await llm.resolve()).model.id).toBe('openrouter/free');
  stored.value.models.openrouter = 'openrouter/auto';
  expect(await llm.resolve()).toMatchObject({
    model: { id: 'openrouter/auto' },
    source: 'settings',
  });

  const pinned = createLlm({ ...KEY, LLM_MODEL: 'openrouter/free' }, stored);
  expect(await pinned.resolve()).toMatchObject({ model: { id: 'openrouter/free' }, source: 'env' });
});

test('a model in Settings that is not in the catalog fails the run, not the server', async () => {
  const llm = createLlm(KEY, settings({ models: { openrouter: 'not/a-model' } }));
  await expect(llm.resolve()).rejects.toThrow(
    'The model in Settings "not/a-model" is not in the openrouter catalog',
  );
});

test('an unknown LLM_MODEL fails fast at startup', () => {
  expect(() => createLlm({ ...KEY, LLM_MODEL: 'not/a-model' })).toThrow(
    'LLM_MODEL "not/a-model" is not in the openrouter catalog',
  );
});

test('the key: the environment wins over Settings; without either the chat asks for one', async () => {
  const stored = settings();
  const env: Record<string, string> = {};
  const llm = createLlm(env, stored);
  expect(await llm.hasApiKey()).toBe(false);
  expect(await llm.apiKeySource()).toBeNull();
  expect(llm.envVar('openrouter')).toBe('OPENROUTER_API_KEY');

  stored.value.apiKeys.openrouter = 'from-settings';
  expect(await llm.apiKey()).toBe('from-settings');
  expect(await llm.apiKeySource()).toBe('settings');

  env.OPENROUTER_API_KEY = 'from-env';
  expect(await llm.apiKey()).toBe('from-env');
  expect(await llm.apiKeySource()).toBe('env');
});

test('the catalog lists the provider chat models with names and context windows', () => {
  const catalog = createLlm(KEY).catalog('openrouter');
  expect(catalog.length).toBeGreaterThan(10);
  expect(catalog).toContainEqual(
    expect.objectContaining({
      id: 'openrouter/free',
      name: expect.any(String),
      contextWindow: expect.any(Number),
    }),
  );
});

test('faux provider exposes a scriptable handle and needs no key', async () => {
  const llm = createLlm({ LLM_PROVIDER: 'faux' });
  expect(llm.model.id).toBe('faux-1');
  expect(await llm.hasApiKey()).toBe(true);
  expect((await llm.resolve()).thinkingLevel).toBe('off');
  // The offline responder; tests replace it with setResponses.
  expect(llm.faux?.getPendingResponseCount()).toBe(1);
  llm.faux?.setResponses([]);
  expect(llm.faux?.getPendingResponseCount()).toBe(0);
});

test('LLM_PROVIDER pins the provider; keys from any of its variables; LLM_MODEL is optional', async () => {
  const llm = createLlm({ LLM_PROVIDER: 'anthropic', ANTHROPIC_OAUTH_TOKEN: 'x' });
  expect(llm.model).toMatchObject({ id: 'claude-sonnet-5-5', provider: 'anthropic' });
  expect(await llm.activeProvider()).toEqual({ id: 'anthropic', source: 'env' });
  expect(llm.envVar('anthropic')).toBe('ANTHROPIC_API_KEY');
  expect(await llm.hasApiKey()).toBe(true);
  const pinned = createLlm({ LLM_PROVIDER: 'anthropic', LLM_MODEL: 'claude-opus-5-5' });
  expect(pinned.model.id).toBe('claude-opus-5-5');
  expect(() => createLlm({ LLM_PROVIDER: 'anthropic', LLM_MODEL: 'gpt-4o' })).toThrow(
    'LLM_MODEL "gpt-4o" is not in the anthropic catalog',
  );
});

test('the provider: Settings choose it among four, each with its own key and model', async () => {
  const stored = settings({
    apiKeys: { openai: 'sk-openai', mistral: 'mist' },
    models: { mistral: 'mistral-small-latest' },
  });
  const llm = createLlm({ MISTRAL_API_KEY: 'mist-env' }, stored);
  expect(llm.providers.map((p) => p.name)).toEqual(['OpenRouter', 'Claude', 'OpenAI', 'Mistral']);
  expect(await llm.activeProvider()).toEqual({ id: 'openrouter', source: 'default' });
  expect(await llm.hasApiKey()).toBe(false);

  stored.value.provider = 'openai';
  expect(await llm.activeProvider()).toEqual({ id: 'openai', source: 'settings' });
  expect(await llm.apiKey()).toBe('sk-openai');
  expect((await llm.resolve()).model).toMatchObject({ id: 'gpt-5.5', provider: 'openai' });

  stored.value.provider = 'mistral';
  expect(await llm.apiKey()).toBe('mist-env');
  expect(await llm.apiKeySource()).toBe('env');
  expect(await llm.resolve()).toMatchObject({
    model: { id: 'mistral-small-latest', provider: 'mistral' },
    thinkingLevel: 'off',
    source: 'settings',
  });
  // LLM_MODEL belongs to OpenRouter (the default provider) here, not to the active one.
  const withModel = createLlm({ LLM_MODEL: 'openrouter/auto' }, stored);
  expect((await withModel.resolve()).model.id).toBe('mistral-small-latest');
  expect(await withModel.modelFor('openrouter')).toEqual({ id: 'openrouter/auto', source: 'env' });
});

test('every default model is in its provider catalog', () => {
  const llm = createLlm(KEY);
  for (const p of llm.providers) {
    expect(llm.catalog(p.id).map((m) => m.id)).toContain(p.defaultModel);
  }
});

test('rejects an unknown LLM_PROVIDER', () => {
  expect(() => createLlm({ LLM_PROVIDER: 'gemini' })).toThrow('Unknown LLM_PROVIDER');
});

test("OpenRouter's daily free quota is permanent, though it says 429 rate limit", () => {
  const llm = createLlm(KEY);
  expect(
    llm.isPermanentError(
      '429: {"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day"}',
    ),
  ).toBe(true);
  expect(llm.isPermanentError('429 Too Many Requests')).toBe(false);
  expect(createLlm({ LLM_PROVIDER: 'faux' }).isPermanentError('free-models-per-day')).toBe(false);
});
