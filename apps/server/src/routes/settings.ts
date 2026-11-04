import {
  isProviderId,
  PROVIDER_IDS,
  type ProviderId,
  type ProviderStatus,
  type SettingsResponse,
  type UpdateSettingsRequest,
} from '@phi/shared';

import type { Llm } from '../agent/llm.ts';
import type { SettingsStore } from '../services/settings.ts';
import { HttpError } from './security.ts';

const hint = (key: string | undefined) => (key ? `…${key.slice(-4)}` : null);

async function providerStatus(llm: Llm, info: Llm['providers'][number]): Promise<ProviderStatus> {
  const [key, keySource, model] = await Promise.all([
    llm.apiKey(info.id),
    llm.apiKeySource(info.id),
    llm.modelFor(info.id),
  ]);
  return {
    id: info.id,
    name: info.name,
    vendor: info.vendor,
    keyConfigured: !!key,
    keyHint: hint(key),
    keySource,
    envVar: llm.envVar(info.id),
    keyUrl: info.keyUrl,
    model: model.id,
    modelCount: llm.catalog(info.id).length,
  };
}

async function describe(llm: Llm): Promise<SettingsResponse> {
  const { id: provider, source: providerSource } = await llm.activeProvider();
  const [key, apiKeySource, configured, providers] = await Promise.all([
    llm.apiKey(),
    llm.apiKeySource(),
    // Some providers (faux) need no key: they count as configured.
    llm.hasApiKey(),
    Promise.all(llm.providers.map((p) => providerStatus(llm, p))),
  ]);
  let model = (await llm.modelFor(provider)).id;
  let modelSource: SettingsResponse['modelSource'] = 'default';
  let modelError: string | undefined;
  try {
    const resolved = await llm.resolve();
    model = resolved.model.id;
    modelSource = resolved.source;
  } catch (err) {
    modelError = err instanceof Error ? err.message : String(err);
  }
  return {
    provider,
    providerSource,
    providers,
    model,
    modelSource,
    ...(modelError ? { modelError } : {}),
    models: llm.catalog(provider),
    apiKeyConfigured: configured,
    apiKeyHint: hint(key),
    apiKeySource,
    apiKeyEnvVar: llm.envVar(provider),
  };
}

const optionalString = (value: unknown, name: string) => {
  if (value !== undefined && typeof value !== 'string')
    throw new HttpError(400, `"${name}" must be a string`);
  return value === undefined ? undefined : value.trim();
};

function parseUpdate(value: unknown): UpdateSettingsRequest {
  if (typeof value !== 'object' || value === null)
    throw new HttpError(400, 'Body must be an object');
  const body = value as Record<string, unknown>;
  const update: UpdateSettingsRequest = {};
  if (body.provider !== undefined) {
    if (!isProviderId(body.provider)) {
      throw new HttpError(400, `"provider" must be one of: ${PROVIDER_IDS.join(', ')}`);
    }
    update.provider = body.provider;
  }
  const model = optionalString(body.model, 'model');
  const apiKey = optionalString(body.apiKey, 'apiKey');
  if (model !== undefined) update.model = model;
  if (apiKey !== undefined) update.apiKey = apiKey;
  if (body.apiKeys !== undefined) {
    if (typeof body.apiKeys !== 'object' || body.apiKeys === null)
      throw new HttpError(400, '"apiKeys" must be an object');
    update.apiKeys = {};
    for (const [id, key] of Object.entries(body.apiKeys)) {
      if (!isProviderId(id)) throw new HttpError(400, `Unknown provider in "apiKeys": ${id}`);
      update.apiKeys[id] = optionalString(key, `apiKeys.${id}`) ?? '';
    }
  }
  return update;
}

/**
 * SPEC 7.1: the provider, its model and one key per provider. Keys are stored server-side and
 * never sent back, only their last 4 characters.
 */
export function settingsHandlers(llm: Llm, settings: SettingsStore) {
  return {
    /** GET /api/settings */
    get: async () => Response.json(await describe(llm)),

    /** PUT /api/settings (see UpdateSettingsRequest). Applies from the next run. */
    put: async (req: Request) => {
      const body: unknown = await req.json().catch(() => {
        throw new HttpError(400, 'Body must be JSON');
      });
      const update = parseUpdate(body);
      const current = await llm.activeProvider();
      if (update.provider !== undefined && update.provider !== current.id) {
        if (current.source === 'env')
          throw new HttpError(409, 'LLM_PROVIDER in the .env file sets the provider');
      }
      const provider = update.provider ?? current.id;
      if ((update.model !== undefined || update.apiKey !== undefined) && !isProviderId(provider)) {
        throw new HttpError(409, `The ${provider} provider has no settings`);
      }
      if (update.model && !llm.catalog(provider).some((m) => m.id === update.model)) {
        throw new HttpError(400, `"${update.model}" is not in the ${provider} catalog`);
      }

      if (update.provider !== undefined && current.source !== 'env')
        await settings.setProvider(update.provider);
      const id = provider as ProviderId;
      if (update.model !== undefined) await settings.setModel(id, update.model);
      if (update.apiKey !== undefined) await settings.setApiKey(id, update.apiKey);
      for (const [key, value] of Object.entries(update.apiKeys ?? {})) {
        await settings.setApiKey(key as ProviderId, value);
      }
      return Response.json(await describe(llm));
    },
  };
}
