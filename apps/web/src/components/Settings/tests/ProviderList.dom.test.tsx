// The provider list clicked for real (happy-dom): switching, opening a key form, removing a key.
// The server is a fake `fetch` that records each PUT /api/settings body.
/// <reference types="bun" />
// First: the DOM must exist before React loads.
import { registerDom, unregisterDom } from '../../../tests/dom.ts';

import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { ProviderStatus, SettingsResponse } from '@phi/shared';
import { createRoot, type Root } from 'react-dom/client';

import { useProjectStore } from '../../../store/project-store.ts';
import { ProviderList } from '../ProviderList.tsx';

const provider = (id: ProviderStatus['id'], name: string, key: string | null): ProviderStatus => ({
  id,
  name,
  vendor: 'v',
  keyConfigured: !!key,
  keyHint: key,
  keySource: key ? 'settings' : null,
  envVar: `${id.toUpperCase()}_API_KEY`,
  keyUrl: `https://example.com/${id}`,
  model: `${id}-model`,
  modelCount: 3,
});

const settings = (active: ProviderStatus['id'], providers: ProviderStatus[]): SettingsResponse => ({
  provider: active,
  providerSource: 'settings',
  providers,
  model: `${active}-model`,
  modelSource: 'default',
  models: [],
  apiKeyConfigured: true,
  apiKeyHint: null,
  apiKeySource: 'settings',
  apiKeyEnvVar: '',
});

const puts: Record<string, unknown>[] = [];
let host: HTMLElement;
let root: Root;
const realFetch = globalThis.fetch;

/** The fake server applies a switch or a key removal to the current settings. */
function fakeFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init?.body)) as {
    provider?: ProviderStatus['id'];
    apiKeys?: Record<string, string>;
  };
  puts.push(body);
  const current = useProjectStore.getState().settings!;
  const providers = current.providers.map((p) =>
    body.apiKeys?.[p.id] === ''
      ? { ...p, keyConfigured: false, keyHint: null, keySource: null }
      : p,
  );
  return Promise.resolve(
    Response.json(settings(body.provider ?? (current.provider as never), providers)),
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const row = (id: string) => host.querySelector<HTMLButtonElement>(`[data-provider="${id}"]`)!;
const active = () =>
  host.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute('data-provider');

beforeAll(() => {
  registerDom();
  globalThis.fetch = fakeFetch as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

beforeEach(async () => {
  puts.length = 0;
  useProjectStore.setState({
    settings: settings('anthropic', [
      provider('openrouter', 'OpenRouter', '…aaaa'),
      provider('anthropic', 'Claude', '…bbbb'),
      provider('openai', 'OpenAI', null),
      provider('mistral', 'Mistral', '…dddd'),
    ]),
  });
  root.render(<ProviderList key={Math.random()} />);
  await tick();
});

afterAll(async () => {
  root.unmount();
  globalThis.fetch = realFetch;
  await unregisterDom();
});

test('one row per provider with its key state; the active one is checked', () => {
  expect([...host.querySelectorAll('[role="radio"]')].map((r) => r.textContent)).toEqual([
    expect.stringContaining('Key …aaaa'),
    expect.stringContaining('Key …bbbb'),
    expect.stringContaining('No key'),
    expect.stringContaining('Key …dddd'),
  ]);
  expect(active()).toBe('anthropic');
  // Roving focus: only the active row is in the tab order.
  expect(row('anthropic').tabIndex).toBe(0);
  expect(row('mistral').tabIndex).toBe(-1);
});

test('clicking a provider with a key switches to it', async () => {
  row('mistral').click();
  for (let i = 0; i < 20 && active() !== 'mistral'; i++) await tick();
  expect(puts).toEqual([{ provider: 'mistral' }]);
  expect(active()).toBe('mistral');
});

test('clicking a provider without a key opens its key form instead of switching', async () => {
  row('openai').click();
  await tick();
  expect(puts).toEqual([]);
  expect(active()).toBe('anthropic');
  const input = host.querySelector<HTMLInputElement>('input[aria-label="OpenAI API key"]');
  expect(input).not.toBeNull();
  expect(host.querySelector('a[href="https://example.com/openai"]')?.textContent).toContain(
    'Get your OpenAI key',
  );
});

test('the key button manages a key without switching; Remove clears only that key', async () => {
  host.querySelector<HTMLButtonElement>('button[aria-label="Manage the Mistral key"]')!.click();
  await tick();
  const remove = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!;
  remove.click();
  for (let i = 0; i < 20 && !row('mistral').textContent?.includes('No key'); i++) await tick();
  expect(puts).toEqual([{ apiKeys: { mistral: '' } }]);
  expect(active()).toBe('anthropic');
});
