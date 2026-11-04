import { createRoot } from 'react-dom/client';

import { startRunWatchdog, startSnapshotSync } from './agent/client.ts';
import { startReviewPresenter } from './agent/reviews.ts';
import { App } from './App.tsx';
import { startProject } from './editor/project.ts';
import { startSession } from './editor/session.ts';
import { initTheme } from './store/theme-store.ts';

initTheme();
startSession();
startSnapshotSync();
// The UI is never stuck "running" (SPEC 8.3).
startRunWatchdog();
// Edit proposals are shown inside their file (SPEC 3.1).
startReviewPresenter();
// The open project (if any), its files and its conversations; the thread stream replays
// everything the server still holds, so a reload mid-run continues.
void startProject();

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');
createRoot(root).render(<App />);
