import type { LspStatusResponse, SettingsResponse } from '@phi/shared';
import { create } from 'zustand';

interface ProjectStore {
  /** Absolute folder of the open project; null until one is open (SPEC 4.4). */
  root: string | null;
  recent: string[];
  /** Loaded once at startup, so the app knows whether to ask for a project. */
  loaded: boolean;
  switching: boolean;
  /** The last failed open (bad path...). */
  error: string | null;
  settingsOpen: boolean;
  settings: SettingsResponse | null;
  /** Whether texlab runs for completion; null until checked. */
  completion: LspStatusResponse | null;
}

export const useProjectStore = create<ProjectStore>(() => ({
  root: null,
  recent: [],
  loaded: false,
  switching: false,
  error: null,
  settingsOpen: false,
  settings: null,
  completion: null,
}));

/** The folder name of an absolute path: "/Users/me/thesis" → "thesis". */
export const folderName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path;

export function openSettings(open = true): void {
  useProjectStore.setState({ settingsOpen: open });
}
