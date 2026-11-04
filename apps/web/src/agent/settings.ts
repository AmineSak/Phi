// The settings panel's actions (SPEC 7). The API key goes to the server and never comes back.

import type { SettingsResponse, UpdateSettingsRequest } from '@phi/shared';

import { api } from '../api/client.ts';
import { useAgentStore } from '../store/agent-store.ts';
import { useProjectStore } from '../store/project-store.ts';

/** Without a key the chat shows the setup card instead of failing runs (SPEC 7.2). */
function showKeyState(settings: SettingsResponse): void {
  const provider = settings.providers.find((p) => p.id === settings.provider)?.name;
  useAgentStore.setState({
    missingKey: settings.apiKeyConfigured
      ? null
      : { envVar: settings.apiKeyEnvVar, provider: provider ?? settings.provider },
  });
}

export async function loadSettings(): Promise<void> {
  try {
    const settings = await api.settings();
    useProjectStore.setState({ settings });
    showKeyState(settings);
  } catch {
    // The panel shows its own error when it opens without settings.
  }
}

/** Saves a change; applies from the next run. Throws with the server's message. */
export async function updateSettings(change: UpdateSettingsRequest): Promise<void> {
  const settings = await api.updateSettings(change);
  useProjectStore.setState({ settings });
  showKeyState(settings);
}

/** "200k context" from a token count. */
export function contextLabel(tokens: number): string {
  if (!tokens) return '';
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M context`;
  return `${Math.round(tokens / 1000)}k context`;
}
