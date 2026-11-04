// Talks to /api/threads/:id and feeds the agent store. No React here.
// One EventSource per open thread carries every event; the browser reconnects it on its own
// and sends Last-Event-ID, so a dropped connection resumes exactly where it stopped.

import {
  COMPILE,
  type ApiError,
  type CompileResult,
  type NoApiKeyError,
  type ReviewConflictError,
  type ReviewDecisionRequest,
  type ReviewDecisionResponse,
  type SendMessageRequest,
  type SendMessageResponse,
  type ThreadHistoryResponse,
  type ThreadListResponse,
  type ThreadStatusResponse,
  type ThreadSummary,
  type WireEvent,
} from '@phi/shared';

import { buildSnapshot, forgetReverts, showCompileResult } from '../editor/session.ts';
import { dispatchReview, resetReviews } from '../store/review-store.ts';
import { endRunLocally, fromHistory } from './reducer.ts';
import {
  dispatchWire,
  dropLocalMessage,
  resetThread,
  upsertLocalMessage,
  useAgentStore,
} from '../store/agent-store.ts';

/** Used only if the thread list can't be loaded. */
export const DEFAULT_THREAD_ID = 'main';
/** localStorage key of the thread this browser showed last (a per-viewer convenience). */
const LAST_THREAD_KEY = 'latex-agent:last-thread';

/** How often a running agent's view of the editor is refreshed (SPEC 5.7). */
export const SNAPSHOT_SYNC_MS = 2000;

const threadUrl = (threadId: string, path: string) =>
  `/api/threads/${encodeURIComponent(threadId)}/${path}`;

let source: EventSource | null = null;
/** The editor as this tab last saw it (JSON), to send only changes made here. */
let lastSeen = '';
/** A snapshot whose PUT failed, retried on the next tick. */
let unsent: string | null = null;

let connecting = 0;
/** When this tab last heard from its thread's stream. */
let lastEventAt = Date.now();

function remember(threadId: string): void {
  try {
    localStorage.setItem(LAST_THREAD_KEY, threadId);
  } catch {
    // Storage blocked: the most recent thread is shown instead next time.
  }
}

function remembered(): string | null {
  try {
    return localStorage.getItem(LAST_THREAD_KEY);
  } catch {
    return null;
  }
}

/**
 * Shows `threadId`: loads its saved history first, then opens its stream from seq 0, which
 * carries everything since this server process loaded it (SPEC 5.4, 5.6).
 */
export async function connect(threadId: string, { force = false } = {}): Promise<void> {
  if (!force && source && useAgentStore.getState().threadId === threadId) return;
  source?.close();
  source = null;
  const attempt = ++connecting;
  resetThread(threadId);
  resetReviews();
  remember(threadId);

  const res = await fetch(threadUrl(threadId, 'messages')).catch(() => null);
  const history = res?.ok ? ((await res.json()) as ThreadHistoryResponse) : null;
  if (attempt !== connecting) return; // another thread was chosen meanwhile
  if (history) resetThread(threadId, fromHistory(history.events));

  const stream = new EventSource(threadUrl(threadId, 'stream?after=0'));
  source = stream;
  stream.onopen = () => useAgentStore.setState({ connection: 'open' });
  stream.onerror = () => {
    // The browser retries by itself while readyState is CONNECTING.
    if (source === stream) useAgentStore.setState({ connection: 'reconnecting' });
  };
  stream.onmessage = (message: MessageEvent<string>) => {
    if (source !== stream) return;
    lastEventAt = Date.now();
    const event = JSON.parse(message.data) as WireEvent;
    const seen = useAgentStore.getState().chat.lastSeq;
    dispatchWire(event);
    dispatchReview(event);
    if (event.seq > seen) {
      showAgentCompile(event);
      onThreadEvent(event);
    }
  };
  // The server restarted: what it had in memory is now on disk. Load it all again.
  stream.addEventListener('reset', () => {
    if (source === stream) void connect(threadId, { force: true });
  });
}

/** Keeps the thread list current; leaves a thread deleted elsewhere. */
function onThreadEvent(event: WireEvent): void {
  if (event.type === 'run_end') void refreshThreads();
  if (event.type !== 'thread_updated') return;
  if (event.deleted && event.threadId === useAgentStore.getState().threadId) {
    void refreshThreads().then(showSomeThread);
  } else {
    void refreshThreads();
  }
}

export async function refreshThreads(): Promise<ThreadSummary[]> {
  const res = await fetch('/api/threads').catch(() => null);
  if (!res?.ok) return useAgentStore.getState().threads;
  const threads = (await res.json()) as ThreadListResponse;
  useAgentStore.setState({ threads });
  return threads;
}

/** Starts a new, empty thread and shows it. */
export async function newThread(): Promise<void> {
  const res = await fetch('/api/threads', { method: 'POST' }).catch(() => null);
  if (!res?.ok) {
    useAgentStore.setState({ error: 'Could not start a new conversation.' });
    return;
  }
  const thread = (await res.json()) as ThreadSummary;
  await refreshThreads();
  await connect(thread.id);
}

/** Shows the last thread this browser used, else the most recent, else a new one. */
async function showSomeThread(threads: ThreadSummary[]): Promise<void> {
  const current = useAgentStore.getState().threadId;
  const last = remembered();
  const pick =
    threads.find((t) => t.id === last && t.id !== current) ?? threads.find((t) => t.id !== current);
  if (pick) await connect(pick.id);
  else await newThread();
}

/** First load: the thread list, then a thread to show. */
export async function startThreads(): Promise<void> {
  const res = await fetch('/api/threads').catch(() => null);
  if (!res?.ok) {
    await connect(DEFAULT_THREAD_ID);
    return;
  }
  const threads = (await res.json()) as ThreadListResponse;
  useAgentStore.setState({ threads });
  const last = remembered();
  const pick = threads.find((t) => t.id === last) ?? threads[0];
  if (pick) await connect(pick.id);
  else await newThread();
}

/** Deletes a thread (its run is stopped first) and shows another (SPEC 5.4). */
export async function deleteThread(threadId: string): Promise<void> {
  // This tab moves on by itself: don't also react to the thread's "deleted" event.
  if (useAgentStore.getState().threadId === threadId) disconnect();
  const res = await fetch(`/api/threads/${encodeURIComponent(threadId)}`, {
    method: 'DELETE',
  }).catch(() => null);
  if (!res?.ok) {
    useAgentStore.setState({ error: 'Could not delete the conversation.' });
    return;
  }
  const threads = await refreshThreads();
  if (useAgentStore.getState().threadId === threadId) await showSomeThread(threads);
}

/** The agent's compiles update the build shown, like the user's own (SPEC 2.4, 6.1). */
function showAgentCompile(event: WireEvent): void {
  if (event.type !== 'tool_end' || event.isError) return;
  const tool = useAgentStore.getState().chat.tools[event.toolCallId];
  const result = event.details as CompileResult | undefined;
  if (tool?.name === COMPILE && result && typeof result.ok === 'boolean') showCompileResult(result);
}

/** Closes the stream (tests, or leaving the page). */
export function disconnect(): void {
  source?.close();
  source = null;
}

/**
 * Sends a message. It shows at once; during a run it shows as queued until the agent's next
 * turn. The server's user_message event, seen by every tab, settles it.
 */
export async function sendMessage(text: string): Promise<void> {
  const threadId = useAgentStore.getState().threadId ?? DEFAULT_THREAD_ID;
  const messageId = crypto.randomUUID();
  const running = useAgentStore.getState().chat.runStatus === 'running';
  upsertLocalMessage(messageId, text, running);
  useAgentStore.setState({ error: null });
  const snapshot = buildSnapshot();
  lastSeen = JSON.stringify(snapshot);
  unsent = null;

  let res: Response;
  try {
    res = await fetch(threadUrl(threadId, 'messages'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, messageId, snapshot } satisfies SendMessageRequest),
    });
  } catch (err) {
    dropLocalMessage(messageId);
    useAgentStore.setState({ error: `Could not reach the server: ${String(err)}` });
    return;
  }

  const body = (await res.json().catch(() => null)) as
    SendMessageResponse | NoApiKeyError | ApiError | null;
  if (res.status === 202 && body && !('error' in body)) {
    forgetReverts(snapshot.revertedToolCallIds);
    upsertLocalMessage(messageId, text, 'queued' in body);
    useAgentStore.setState({ missingKey: null });
    return;
  }
  dropLocalMessage(messageId);
  if (body && 'error' in body && body.error === 'no_api_key' && 'envVar' in body) {
    useAgentStore.setState({ missingKey: { envVar: body.envVar, provider: body.provider } });
    return;
  }
  const message = body && 'error' in body ? body.error : `${res.status} ${res.statusText}`;
  useAgentStore.setState({ error: message });
}

/**
 * While a run is active, sends the editor snapshot every 2 s when it changed, so the agent's
 * view stays current during long runs (SPEC 5.7). Only changes made in this tab are sent:
 * every tab sees the run, and an idle tab must not overwrite the view of the one in use.
 * Returns a stop function.
 */
export function startSnapshotSync(): () => void {
  lastSeen = JSON.stringify(buildSnapshot());
  const timer = setInterval(() => {
    const current = JSON.stringify(buildSnapshot());
    const changed = current !== lastSeen;
    lastSeen = current;
    const running = useAgentStore.getState().chat.runStatus === 'running';
    if (!running || document.visibilityState !== 'visible') {
      unsent = null;
      return;
    }
    const body = changed ? current : unsent;
    if (body === null) return;
    unsent = null;
    const threadId = useAgentStore.getState().threadId ?? DEFAULT_THREAD_ID;
    void fetch(threadUrl(threadId, 'snapshot'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
      .then((res) => {
        if (!res.ok) unsent ??= body;
      })
      .catch(() => {
        unsent ??= body;
      });
  }, SNAPSHOT_SYNC_MS);
  return () => clearInterval(timer);
}

/** Another tab decided the proposal first (SPEC 3.7). */
export class AlreadyDecidedError extends Error {
  override name = 'AlreadyDecidedError';
}

/** Sends the user's decision on a proposal. Throws AlreadyDecidedError on 409. */
export async function postDecision(
  toolCallId: string,
  decision: ReviewDecisionRequest,
): Promise<ReviewDecisionResponse> {
  const threadId = useAgentStore.getState().threadId ?? DEFAULT_THREAD_ID;
  const res = await fetch(threadUrl(threadId, `reviews/${encodeURIComponent(toolCallId)}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(decision),
  });
  const body = (await res.json().catch(() => null)) as
    ReviewDecisionResponse | ReviewConflictError | ApiError | null;
  if (res.ok && body && !('error' in body)) return body;
  if (res.status === 409 && body && 'error' in body && body.error === 'already_decided') {
    throw new AlreadyDecidedError('This proposal was already decided in another tab.');
  }
  const message =
    body && 'message' in body ? String(body.message) : body && 'error' in body ? body.error : '';
  throw new Error(message || `${res.status} ${res.statusText}`);
}

/** A run that sent nothing for this long gets its status checked (SPEC 8.3). */
export const STALL_MS = 60_000;
const WATCHDOG_MS = 10_000;
export const LOST_RUN_ERROR =
  'The run ended without a final update from the server. Reload the page to see what happened.';

/**
 * One watchdog check: if this tab believes a run is active but heard nothing for 60 s, ask
 * the server; if it runs nothing, end the run here with an error. True when it ended one.
 */
export async function checkStalledRun(
  now: number,
  lastHeard: number,
  fetchStatus: () => Promise<ThreadStatusResponse | null>,
): Promise<boolean> {
  if (useAgentStore.getState().chat.runStatus !== 'running' || now - lastHeard < STALL_MS) {
    return false;
  }
  const status = await fetchStatus();
  // Unknown (server unreachable): the stream reconnects by itself; check again later.
  if (!status || status.running || useAgentStore.getState().chat.runStatus !== 'running') {
    return false;
  }
  useAgentStore.setState((s) => ({ chat: endRunLocally(s.chat, LOST_RUN_ERROR) }));
  return true;
}

/** Runs checkStalledRun every 10 s for the shown thread. Returns a stop function. */
export function startRunWatchdog(): () => void {
  const timer = setInterval(() => {
    const threadId = useAgentStore.getState().threadId;
    if (!threadId) return;
    const lastHeard = lastEventAt;
    void checkStalledRun(Date.now(), lastHeard, async () => {
      lastEventAt = Date.now(); // one check per quiet minute, not one every 10 s
      const res = await fetch(threadUrl(threadId, 'status')).catch(() => null);
      return res?.ok ? ((await res.json()) as ThreadStatusResponse) : null;
    });
  }, WATCHDOG_MS);
  return () => clearInterval(timer);
}

/** Stops the running agent (SPEC 5.3). run_end "aborted" arrives on the stream. */
export async function abort(): Promise<void> {
  const threadId = useAgentStore.getState().threadId ?? DEFAULT_THREAD_ID;
  const res = await fetch(threadUrl(threadId, 'abort'), { method: 'POST' }).catch(() => null);
  if (!res?.ok) useAgentStore.setState({ error: 'Could not stop the agent; try again.' });
}
