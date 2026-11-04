// A browser DOM (happy-dom) for tests that click real buttons. Import it FIRST in the test
// file: React and CodeMirror check what the DOM supports when they load, so it must exist
// before they are imported. Call `unregisterDom()` in afterAll so other test files get Bun's
// own globals (fetch, Response...) back, and `registerDom()` in beforeAll: one `bun test` run
// shares this module between files, so its import-time registration happens only once.
import { GlobalRegistrator } from '@happy-dom/global-registrator';

export function registerDom(): void {
  if (GlobalRegistrator.isRegistered) return;
  GlobalRegistrator.register({ url: 'http://127.0.0.1:3000/' });
  // Browsers fire selectionchange after CodeMirror writes the selection; happy-dom fires it
  // synchronously, inside CodeMirror's own update. Tests set selections programmatically.
  document.addEventListener('selectionchange', (e) => e.stopImmediatePropagation(), true);
}

registerDom();

export async function unregisterDom(): Promise<void> {
  // Let React's scheduler run what an unmount or a last render queued: once the DOM is gone,
  // that work fails with "window is not defined" between test files.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  await GlobalRegistrator.unregister();
}
