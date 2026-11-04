import { create } from 'zustand';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'latex-agent:theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

function readStored(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

function apply(mode: ThemeMode): void {
  const dark = mode === 'dark' || (mode === 'system' && media.matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

export const useThemeStore = create<{ mode: ThemeMode }>(() => ({ mode: readStored() }));

export function setThemeMode(mode: ThemeMode): void {
  useThemeStore.setState({ mode });
  apply(mode);
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Private mode or blocked storage: the choice lasts for this session only.
  }
}

/** Applies the stored mode and follows OS changes while in "system". */
export function initTheme(): void {
  apply(useThemeStore.getState().mode);
  media.addEventListener('change', () => apply(useThemeStore.getState().mode));
}
