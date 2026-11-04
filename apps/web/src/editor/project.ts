// Opening projects (SPEC 4.4). No React here.

import { api } from '../api/client.ts';
import { loadSettings } from '../agent/settings.ts';
import { disconnect, startThreads } from '../agent/client.ts';
import { initialChatState } from '../agent/reducer.ts';
import { useAgentStore } from '../store/agent-store.ts';
import { useEditorStore } from '../store/editor-store.ts';
import { useProjectStore } from '../store/project-store.ts';
import { resetReviews } from '../store/review-store.ts';
import { startLsp, stopLsp } from './lsp.ts';
import { loadFileList, openFile, refreshRoot, resetWorkspace } from './session.ts';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Loads the open project's files and conversations, and opens main.tex if there is one. */
async function showProject(): Promise<void> {
  void startThreads();
  const root = useProjectStore.getState().root;
  if (root) void startLsp(root);
  await loadFileList();
  // Opening a text file also looks up its compile root; otherwise look it up directly.
  if (useEditorStore.getState().files.some((f) => f.path === 'main.tex'))
    await openFile('main.tex');
  else await refreshRoot();
}

/** First load: which project is open (maybe none yet), then its contents. */
export async function startProject(): Promise<void> {
  void loadSettings();
  try {
    const { root, recent } = await api.project();
    useProjectStore.setState({ root, recent, loaded: true, error: null });
    if (root) await showProject();
  } catch (err) {
    useProjectStore.setState({ loaded: true, error: message(err) });
  }
}

/**
 * Opens the project at absolute `path`. The server stops the agent's work in the current one;
 * here unsaved edits are saved first, then files, tabs, the PDF and conversations reload.
 * False (with the reason in the store) when the path can't be opened.
 */
export async function switchProject(path: string): Promise<boolean> {
  useProjectStore.setState({ switching: true, error: null });
  try {
    await resetWorkspace();
    stopLsp();
    const { root, recent } = await api.openProject({ path: path.trim() });
    disconnect();
    resetReviews();
    useAgentStore.setState({ chat: initialChatState, threads: [], threadId: null, error: null });
    useProjectStore.setState({ root, recent, switching: false });
    await showProject();
    return true;
  } catch (err) {
    useProjectStore.setState({ switching: false, error: message(err) });
    // The old project is still open; bring its files back.
    if (useProjectStore.getState().root) await showProject();
    return false;
  }
}
