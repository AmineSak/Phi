// The only file that knows which LLM provider and model are used.

import type { StreamFn, ThinkingLevel } from '@earendil-works/pi-agent-core';
import {
  createModels,
  type Api,
  type Model,
  type MutableModels,
  type Provider,
} from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { mistralProvider } from '@earendil-works/pi-ai/providers/mistral';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxProviderHandle,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai/providers/faux';
import { isProviderId, LIST_FILES, PROVIDER_IDS, type ProviderId } from '@phi/shared';

import type { GlobalSettings } from '../services/settings.ts';

/** Where a setting's value came from: the environment wins over the settings file. */
export type SettingSource = 'env' | 'settings' | 'default';

export interface ModelChoice {
  id: string;
  name: string;
  contextWindow: number;
}

/** What a run uses, resolved when it starts (SPEC 7.1). */
export interface ResolvedModel {
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  source: SettingSource;
}

/** A provider the user can pick in Settings. */
export interface ProviderInfo {
  id: ProviderId;
  name: string;
  vendor: string;
  /** Environment variables that hold its key, the usual one first. */
  envVars: string[];
  keyUrl: string;
  defaultModel: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo & { create: () => Provider<Api> }> = {
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    vendor: 'Many models, one key',
    envVars: ['OPENROUTER_API_KEY'],
    keyUrl: 'https://openrouter.ai/keys',
    defaultModel: 'openrouter/free',
    create: openrouterProvider,
  },
  anthropic: {
    id: 'anthropic',
    name: 'Claude',
    vendor: 'Anthropic',
    envVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-sonnet-5-5',
    create: anthropicProvider,
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    vendor: 'GPT models',
    envVars: ['OPENAI_API_KEY'],
    keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-5.5',
    create: openaiProvider,
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral',
    vendor: 'Mistral AI',
    envVars: ['MISTRAL_API_KEY'],
    keyUrl: 'https://console.mistral.ai/api-keys',
    defaultModel: 'mistral-large-latest',
    create: mistralProvider,
  },
};

export interface Llm {
  models: MutableModels;
  /** The model at startup; each run resolves the current one with `resolve()`. */
  model: Model<Api>;
  streamFn: StreamFn;
  /** Set when LLM_PROVIDER=faux, so tests can script responses. */
  faux?: FauxProviderHandle;
  /** The providers Settings offers; empty in offline (faux) mode. */
  providers: ProviderInfo[];
  /** The provider the next run uses: LLM_PROVIDER, else Settings, else OpenRouter. */
  activeProvider: () => Promise<{ id: string; source: SettingSource }>;
  /** A provider's name for messages ("Claude"). */
  providerName: (id: string) => string;
  /** A provider's chat models, for the settings panel. */
  catalog: (provider: string) => ModelChoice[];
  /** The model id a provider uses: LLM_MODEL (its provider only), else Settings, else default. */
  modelFor: (provider: string) => Promise<{ id: string; source: SettingSource }>;
  /** The active provider's model and thinking level for the next run. */
  resolve: () => Promise<ResolvedModel>;
  /** A provider's key (the active one's by default): its environment variable, else Settings. */
  apiKey: (provider?: string) => Promise<string | undefined>;
  apiKeySource: (provider?: string) => Promise<'env' | 'settings' | null>;
  /** The environment variable that overrides a provider's stored key ('' when none applies). */
  envVar: (provider: string) => string;
  /** Whether the active provider has a key now. Runs are refused without one (SPEC 7.2). */
  hasApiKey: () => Promise<boolean>;
  /**
   * Provider errors that look transient to pi's classifier but are not (an exhausted daily
   * quota), so retrying them only wastes time (SPEC 8.2).
   */
  isPermanentError: (errorMessage: string) => boolean;
}

/** OpenRouter's daily free-model quota answers 429 "Rate limit exceeded: free-models-per-day". */
const OPENROUTER_QUOTA = /free-models-per-day|add \d+ credits/i;

const DEFAULT_PROVIDER: ProviderId = 'openrouter';

type Env = Record<string, string | undefined>;
type SettingsReader = { read: () => Promise<GlobalSettings> };

const NO_SETTINGS: SettingsReader = {
  read: async () => ({ apiKeys: {}, models: {}, recentProjects: [] }),
};

/**
 * OpenRouter's routers (openrouter/free, openrouter/auto) list a placeholder 4096-token output
 * limit, and pi sends a model's limit as max_tokens on every request. A reasoning model then
 * runs out mid-thought: 4096 tokens cover the thinking and the answer. The models they route to
 * allow far more, so routers get this budget (pi still clamps it to the context window).
 */
export const ROUTER_OUTPUT_TOKENS = 32_000;

const withOutputBudget = (provider: string, model: Model<Api>): Model<Api> =>
  provider === 'openrouter' &&
  model.id.startsWith('openrouter/') &&
  model.maxTokens < ROUTER_OUTPUT_TOKENS
    ? { ...model, maxTokens: ROUTER_OUTPUT_TOKENS }
    : model;

/**
 * "off" makes pi send reasoning effort "none", which endpoints with mandatory reasoning reject
 * (openrouter/free often routes to one). Reasoning models get a light level instead.
 */
const thinkingFor = (provider: string, model: Model<Api>): ThinkingLevel =>
  provider === 'openrouter' && model.reasoning ? 'low' : 'off';

/**
 * The provider is chosen in Settings among OpenRouter, Claude, OpenAI and Mistral, each with its
 * own key and model (SPEC 7.1). The environment overrides:
 * - LLM_PROVIDER pins the provider; "faux" is a scripted offline provider for tests and offline
 *   dev (FAUX_TOKENS_PER_SECOND slows its streaming down, e.g. to try Stop mid-run).
 * - LLM_MODEL pins the model of LLM_PROVIDER (default OpenRouter); checked at startup.
 * - OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, MISTRAL_API_KEY override stored keys.
 * A missing key does not stop the server; the chat asks for one instead.
 */
export function createLlm(env: Env = process.env, settings: SettingsReader = NO_SETTINGS): Llm {
  const models = createModels();
  const streamFn: StreamFn = models.streamSimple.bind(models);

  if (env.LLM_PROVIDER === 'faux') {
    const tokensPerSecond = Number(env.FAUX_TOKENS_PER_SECOND) || undefined;
    const faux = fauxProvider({ tokensPerSecond });
    models.setProvider(faux.provider);
    faux.setResponses([offlineResponder(faux)]);
    const model = faux.getModel();
    return {
      models,
      model,
      streamFn,
      faux,
      providers: [],
      activeProvider: async () => ({ id: 'faux', source: 'env' }),
      providerName: () => 'Offline model',
      catalog: () => [{ id: model.id, name: model.name, contextWindow: model.contextWindow }],
      modelFor: async () => ({ id: model.id, source: 'default' }),
      resolve: async () => ({ model, thinkingLevel: 'off', source: 'default' }),
      apiKey: async () => undefined,
      apiKeySource: async () => null,
      envVar: () => '',
      hasApiKey: async () => true,
      isPermanentError: () => false,
    };
  }

  const pinned = env.LLM_PROVIDER || null;
  if (pinned !== null && !isProviderId(pinned)) {
    throw new Error(
      `Unknown LLM_PROVIDER "${pinned}". Use ${PROVIDER_IDS.map((p) => `"${p}"`).join(', ')} or "faux".`,
    );
  }
  for (const info of Object.values(PROVIDERS)) models.setProvider(info.create());

  const info = (id: string) => (isProviderId(id) ? PROVIDERS[id] : null);
  const lookup = (provider: string, id: string) => models.getModel(provider, id);
  const unknown = (provider: string, id: string, where: string) => {
    const count = models.getModels(provider).length;
    return new Error(
      `${where} "${id}" is not in the ${provider} catalog (${count} models). Pick one in Settings.`,
    );
  };

  // LLM_MODEL belongs to the pinned (or default) provider. A bad one is a setup mistake: fail at
  // startup, not on the first message.
  const modelProvider: ProviderId = pinned ?? DEFAULT_PROVIDER;
  if (env.LLM_MODEL && !lookup(modelProvider, env.LLM_MODEL)) {
    throw unknown(modelProvider, env.LLM_MODEL, 'LLM_MODEL');
  }
  const startupId = env.LLM_MODEL || PROVIDERS[modelProvider].defaultModel;
  const startup = lookup(modelProvider, startupId);
  if (!startup) throw unknown(modelProvider, startupId, 'The default model');

  const activeProvider = async (): Promise<{ id: ProviderId; source: SettingSource }> => {
    if (pinned) return { id: pinned, source: 'env' };
    const stored = (await settings.read()).provider;
    return stored
      ? { id: stored, source: 'settings' }
      : { id: DEFAULT_PROVIDER, source: 'default' };
  };
  const target = async (provider?: string) => provider ?? (await activeProvider()).id;
  const envKey = (provider: string) =>
    info(provider)
      ?.envVars.map((n) => env[n])
      .find((v) => !!v);
  const storedKey = async (provider: string) =>
    isProviderId(provider) ? (await settings.read()).apiKeys[provider] : undefined;
  const apiKey = async (provider?: string) => {
    const id = await target(provider);
    return envKey(id) || (await storedKey(id)) || undefined;
  };
  const modelFor = async (provider: string): Promise<{ id: string; source: SettingSource }> => {
    if (provider === modelProvider && env.LLM_MODEL) return { id: env.LLM_MODEL, source: 'env' };
    const stored = isProviderId(provider) ? (await settings.read()).models[provider] : undefined;
    if (stored) return { id: stored, source: 'settings' };
    return { id: info(provider)?.defaultModel ?? '', source: 'default' };
  };

  return {
    models,
    model: startup,
    streamFn,
    providers: Object.values(PROVIDERS).map(({ create: _create, ...rest }) => rest),
    activeProvider,
    providerName: (id) => info(id)?.name ?? id,
    catalog: (provider) =>
      models
        .getModels(provider)
        .map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow })),
    modelFor,
    resolve: async () => {
      const { id: provider } = await activeProvider();
      const { id, source } = await modelFor(provider);
      const model = lookup(provider, id);
      if (!model) {
        throw unknown(provider, id, source === 'settings' ? 'The model in Settings' : 'LLM_MODEL');
      }
      return {
        model: withOutputBudget(provider, model),
        thinkingLevel: thinkingFor(provider, model),
        source,
      };
    },
    apiKey,
    apiKeySource: async (provider) => {
      const id = await target(provider);
      return envKey(id) ? 'env' : (await storedKey(id)) ? 'settings' : null;
    },
    envVar: (provider) => info(provider)?.envVars[0] ?? '',
    hasApiKey: async () => !!(await apiKey()),
    isPermanentError: (message) => OPENROUTER_QUOTA.test(message),
  };
}

/**
 * Default faux behaviour for offline dev: list the project's files, then report them.
 * It re-queues itself each call; tests replace it with their own script via setResponses.
 */
function offlineResponder(faux: FauxProviderHandle): FauxResponseFactory {
  const respond: FauxResponseFactory = (context) => {
    faux.appendResponses([respond]);
    const last = context.messages.at(-1);
    if (last?.role === 'toolResult') {
      const listing = last.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
      return fauxAssistantMessage(
        `(offline faux model) The project contains:\n\n${listing
          .split('\n')
          .map((path) => `- \`${path}\``)
          .join(
            '\n',
          )}\n\nThis is a scripted reply from the offline model, used for development without an API key. It lists the project files with the same tool the real agent uses, then streams this paragraph slowly enough to try **Stop**, a second tab, or reloading the page in the middle of a run.`,
      );
    }
    return fauxAssistantMessage([
      fauxText('(offline faux model) Let me look at the project.'),
      fauxToolCall(LIST_FILES, {}),
    ]);
  };
  return respond;
}
