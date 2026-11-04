// Global settings (SPEC 7, 4.4): ~/.latex-agent/settings.json, readable by the user only.
// Environment variables override what is stored here; llm.ts decides which ones apply.
// Per-project settings (rootFile) live in <project>/.latex-agent/settings.json instead.

import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { isProviderId, type ProviderId } from '@phi/shared';

export interface GlobalSettings {
  /** The provider runs use, when not pinned by LLM_PROVIDER. */
  provider?: ProviderId;
  /** One key per provider. */
  apiKeys: Partial<Record<ProviderId, string>>;
  /** The model chosen for each provider. */
  models: Partial<Record<ProviderId, string>>;
  /** Absolute project folders, most recent first. */
  recentProjects: string[];
}

/** Known providers' non-empty strings from a stored map. */
function providerMap(value: unknown): Partial<Record<ProviderId, string>> {
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([id, v]) => isProviderId(id) && typeof v === 'string' && v),
  );
}

// ~/.latex-agent: the project's working title, kept so existing settings stay found.
export const DEFAULT_SETTINGS_PATH = join(homedir(), '.latex-agent', 'settings.json');
export const MAX_RECENT_PROJECTS = 10;

/** The settings file can't be parsed; the user has to fix or delete it. */
export class SettingsError extends Error {
  override name = 'SettingsError';
}

function parse(text: string, path: string): GlobalSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SettingsError(`${path} is not valid JSON; fix or delete it.`);
  }
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const apiKeys = providerMap(value.apiKeys);
  const models = providerMap(value.models);
  // Before providers could be switched, the one key and model were OpenRouter's.
  if (typeof value.apiKey === 'string' && value.apiKey) apiKeys.openrouter ??= value.apiKey;
  if (typeof value.model === 'string' && value.model) models.openrouter ??= value.model;
  return {
    ...(isProviderId(value.provider) ? { provider: value.provider } : {}),
    apiKeys,
    models,
    recentProjects: Array.isArray(value.recentProjects)
      ? value.recentProjects.filter((p): p is string => typeof p === 'string')
      : [],
  };
}

const empty = (): GlobalSettings => ({ apiKeys: {}, models: {}, recentProjects: [] });

/** `map` with `id` set to `value`, or without it when `value` is empty. */
function withEntry(
  map: Partial<Record<ProviderId, string>>,
  id: ProviderId,
  value: string | undefined,
): Partial<Record<ProviderId, string>> {
  const { [id]: _old, ...rest } = map;
  return value ? { ...rest, [id]: value } : rest;
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;

export function createSettingsStore(path = DEFAULT_SETTINGS_PATH) {
  let cache: GlobalSettings | null = null;
  let writing: Promise<void> = Promise.resolve();

  async function read(): Promise<GlobalSettings> {
    if (cache) return cache;
    const file = Bun.file(path);
    cache = (await file.exists()) ? parse(await file.text(), path) : empty();
    return cache;
  }

  /** Writes atomically (temp file, then rename), mode 0600 in a 0700 folder. */
  async function write(next: GlobalSettings): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, path);
    cache = next;
  }

  /** Applies `change` to the stored settings; changes run one at a time. */
  function update(change: (current: GlobalSettings) => GlobalSettings): Promise<GlobalSettings> {
    const result = writing.then(async () => {
      const next = change(await read());
      await write(next);
      return next;
    });
    writing = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    path,
    read,

    /** Sets the provider runs use; undefined goes back to the default. */
    setProvider: (provider: ProviderId | undefined) =>
      update(({ provider: _old, ...rest }) => (provider ? { ...rest, provider } : rest)),

    /** Sets a provider's model id; undefined or '' removes it (back to the default). */
    setModel: (provider: ProviderId, model: string | undefined) =>
      update((s) => ({ ...s, models: withEntry(s.models, provider, model) })),

    /** Sets a provider's API key; undefined or '' removes it. */
    setApiKey: (provider: ProviderId, apiKey: string | undefined) =>
      update((s) => ({ ...s, apiKeys: withEntry(s.apiKeys, provider, apiKey) })),

    /** Moves `root` to the front of the recent projects (at most 10). */
    addRecentProject: (root: string) =>
      update((s) => ({
        ...s,
        recentProjects: [root, ...s.recentProjects.filter((p) => p !== root)].slice(
          0,
          MAX_RECENT_PROJECTS,
        ),
      })),
  };
}
