import type { Server } from 'bun';
import index from '../../web/index.html';
import { createLlm } from './agent/llm.ts';
import { loadConfig } from './config.ts';
import { checkProjectPath, createProjects, type ProjectContext } from './project.ts';
import { health } from './routes/health.ts';
import { lspHandlers, type LspSocketData } from './routes/lsp.ts';
import { pdfWorker } from './routes/pdf-worker.ts';
import { projectHandlers } from './routes/project.ts';
import { guard, type Access, type Handler } from './routes/security.ts';
import { settingsHandlers } from './routes/settings.ts';
import { createIapVerifier } from './services/iap.ts';
import { createSettingsStore } from './services/settings.ts';

const config = loadConfig(process.env);
const settings = createSettingsStore();
const llm = createLlm(process.env, settings);
/** Who may call the API: this machine, or (deployed) the public origin behind IAP (SPEC 9.1). */
const access: Access = {
  port: config.port,
  publicOrigin: config.publicOrigin,
  iap: config.iap ? createIapVerifier(config.iap) : null,
};

/** PROJECT_ROOT, else the most recent project that still exists, else none (the app asks). */
async function initialRoot(): Promise<string | null> {
  if (config.initialProjectRoot) return config.initialProjectRoot;
  for (const path of (await settings.read()).recentProjects) {
    const root = await checkProjectPath(path, config.projectsDir).catch(() => null);
    if (root) return root;
  }
  return null;
}

// Late-bound: the language server sockets read the open project, and close when it changes.
let lsp: ReturnType<typeof lspHandlers> | null = null;
const projects = createProjects({
  initialRoot: await initialRoot(),
  llm,
  settings,
  projectsDir: config.projectsDir,
  onSwitch: () => lsp?.closeAll(),
});
lsp = lspHandlers({ access, root: () => projects.root() });
const lspApi = lsp;
const startRoot = projects.root();
if (startRoot) await settings.addRecentProject(startRoot);

const api = (handler: Handler) => guard(handler, access);
/** A handler of the project open at request time (SPEC 4.4): never one captured at startup. */
const inProject = (pick: (project: ProjectContext) => Handler) =>
  api((req) => pick(projects.current())(req));
const settingsApi = settingsHandlers(llm, settings);
const projectApi = projectHandlers(projects, settings);

const server = Bun.serve<LspSocketData>({
  hostname: config.host,
  port: config.port,
  idleTimeout: 0, // thread streams stay open as long as a tab is open
  // Uploads are capped at 20 MB (SPEC 4.2); refuse far larger bodies before reading them.
  maxRequestBodySize: 25 * 1024 * 1024,
  // Deployed: bundled once, minified, no hot-reload socket (SPEC 9.3).
  development: config.production ? false : { hmr: true, console: true },
  routes: {
    '/': index,
    '/pdf.worker.mjs': { GET: pdfWorker },
    // For the load balancer's health checks, which carry neither Origin nor IAP's token.
    '/healthz': { GET: () => new Response('ok') },
    '/api/health': { GET: api(() => health(projects.root())) },
    '/api/settings': { GET: api(settingsApi.get), PUT: api(settingsApi.put) },
    '/api/project': { GET: api(projectApi.get), POST: api(projectApi.open) },
    '/api/project/archive': { GET: api(projectApi.archive) },
    '/api/projects': { GET: api(projectApi.list), POST: api(projectApi.create) },
    '/api/templates': { GET: api(projectApi.templates) },
    '/api/lsp/status': { GET: api(lspApi.status) },
    // Checks the Origin itself: a WebSocket upgrade can't go through guard's JSON wrapper.
    '/api/lsp': { GET: (req: Request, srv: Server<LspSocketData>) => lspApi.upgrade(req, srv) },
    '/api/files': {
      GET: inProject((p) => p.files.list),
      POST: inProject((p) => p.files.create),
    },
    // A file literally named "rename" still reads, saves and deletes like any other.
    '/api/files/rename': {
      POST: inProject((p) => p.files.rename),
      GET: inProject((p) => p.files.read),
      PUT: inProject((p) => p.files.write),
      DELETE: inProject((p) => p.files.remove),
    },
    '/api/files/*': {
      GET: inProject((p) => p.files.read),
      PUT: inProject((p) => p.files.write),
      DELETE: inProject((p) => p.files.remove),
    },
    '/api/upload/*': { POST: inProject((p) => p.files.upload) },
    '/api/raw/*': { GET: inProject((p) => p.files.raw) },
    '/api/compile': { POST: inProject((p) => p.compile.compile) },
    '/api/root': { GET: inProject((p) => p.compile.root) },
    '/api/pdf': { GET: inProject((p) => p.compile.pdf) },
    '/api/synctex/edit': { GET: inProject((p) => p.compile.synctexEdit) },
    '/api/synctex/view': { GET: inProject((p) => p.compile.synctexView) },
    '/api/threads': {
      GET: inProject((p) => p.agent.listThreads),
      POST: inProject((p) => p.agent.createThread),
    },
    '/api/threads/:id': { DELETE: inProject((p) => p.agent.deleteThread) },
    '/api/threads/:id/messages': {
      GET: inProject((p) => p.agent.history),
      POST: inProject((p) => p.agent.messages),
    },
    '/api/threads/:id/abort': { POST: inProject((p) => p.agent.abort) },
    '/api/threads/:id/status': { GET: inProject((p) => p.agent.status) },
    '/api/threads/:id/snapshot': { PUT: inProject((p) => p.agent.snapshot) },
    '/api/threads/:id/reviews/:toolCallId': { POST: inProject((p) => p.agent.review) },
    '/api/threads/:id/stream': { GET: inProject((p) => p.agent.stream) },
    '/api/*': api(() => Response.json({ error: 'Not found' }, { status: 404 })),
  },
  websocket: lspApi.websocket,
  fetch: () => new Response('Not found', { status: 404 }),
});

console.log(
  startRoot
    ? `Serving ${startRoot} at ${server.url}`
    : `No project open yet: open one at ${server.url}`,
);
