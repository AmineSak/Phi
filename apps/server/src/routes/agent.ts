import {
  MAX_SELECTION_CHARS,
  MAX_SNAPSHOT_DIRTY_BYTES,
  MAX_SNAPSHOT_DIRTY_FILES,
  type EditorSnapshot,
  type HunkDecision,
  type NoApiKeyError,
  type ReviewConflictError as ReviewConflictBody,
  type ReviewDecisionRequest,
  type SendMessageRequest,
  type SendMessageResponse,
  type ThreadHistoryResponse,
  type ThreadListResponse,
  type ThreadStatusResponse,
  type ThreadSummary,
  type WireEvent,
} from '@phi/shared';

import type { Llm } from '../agent/llm.ts';
import { decideReview, InvalidDecisionError, ReviewConflictError } from '../agent/reviews.ts';
import type { Thread, Threads } from '../agent/threads.ts';
import { HttpError } from './security.ts';

const PING_MS = 15_000;
const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_CALL_ID = /^[A-Za-z0-9_.:|-]{1,200}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** :id from /api/threads/:id/... */
function threadId(req: Request): string {
  const id = new URL(req.url).pathname.split('/')[3] ?? '';
  if (!THREAD_ID.test(id)) throw new HttpError(400, 'Invalid thread id');
  return id;
}

const isLine = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Validates an EditorSnapshot's shape and limits; cuts an over-long selection to 2000 chars. */
export function parseSnapshot(value: unknown): EditorSnapshot {
  const bad = (problem: string) => new HttpError(400, `Invalid snapshot: ${problem}`);
  if (!isRecord(value)) throw bad('must be an object');
  const { activeFile, cursorLine, selection, dirtyFiles, revertedToolCallIds } = value;
  if (activeFile !== null && typeof activeFile !== 'string')
    throw bad('"activeFile" must be a path or null');
  if (cursorLine !== null && !isLine(cursorLine))
    throw bad('"cursorLine" must be a line number or null');

  let parsedSelection: EditorSnapshot['selection'];
  if (selection !== undefined && selection !== null) {
    if (!isRecord(selection)) throw bad('"selection" must be an object');
    const { from, to, text } = selection;
    if (!isLine(from) || !isLine(to) || to < from || typeof text !== 'string') {
      throw bad('"selection" needs line numbers from <= to and a text');
    }
    parsedSelection = { from, to, text: text.slice(0, MAX_SELECTION_CHARS) };
  }

  if (!Array.isArray(dirtyFiles)) throw bad('"dirtyFiles" must be an array');
  if (dirtyFiles.length > MAX_SNAPSHOT_DIRTY_FILES) {
    throw bad(`at most ${MAX_SNAPSHOT_DIRTY_FILES} dirty files`);
  }
  let bytes = 0;
  const files = dirtyFiles.map((file: unknown) => {
    if (!isRecord(file) || typeof file.path !== 'string' || typeof file.content !== 'string') {
      throw bad('each dirty file needs a path and a content');
    }
    bytes += Buffer.byteLength(file.content);
    return { path: file.path, content: file.content };
  });
  if (bytes > MAX_SNAPSHOT_DIRTY_BYTES) {
    throw bad(`dirty files total ${bytes} bytes; the limit is ${MAX_SNAPSHOT_DIRTY_BYTES}`);
  }

  if (
    !Array.isArray(revertedToolCallIds) ||
    !revertedToolCallIds.every((id) => typeof id === 'string')
  ) {
    throw bad('"revertedToolCallIds" must be an array of strings');
  }
  return {
    activeFile,
    cursorLine,
    ...(parsedSelection ? { selection: parsedSelection } : {}),
    dirtyFiles: files,
    revertedToolCallIds,
  };
}

/** Validates a review decision's shape; whether it fits the proposal is checked by the agent. */
export function parseDecision(value: unknown): ReviewDecisionRequest {
  const bad = (problem: string) => new HttpError(400, `Invalid decision: ${problem}`);
  if (!isRecord(value)) throw bad('must be an object');
  switch (value.decision) {
    case 'accepted': {
      if (value.hunks === undefined) return { decision: 'accepted' };
      if (!Array.isArray(value.hunks)) throw bad('"hunks" must be an array');
      const hunks = value.hunks.map((h: unknown): HunkDecision => {
        if (!isRecord(h) || !Number.isInteger(h.index) || typeof h.accepted !== 'boolean') {
          throw bad('each hunk needs an integer "index" and a boolean "accepted"');
        }
        if (h.finalText !== undefined && typeof h.finalText !== 'string') {
          throw bad('"finalText" must be a string');
        }
        return {
          index: h.index as number,
          accepted: h.accepted,
          ...(typeof h.finalText === 'string' ? { finalText: h.finalText } : {}),
        };
      });
      return { decision: 'accepted', hunks };
    }
    case 'rejected':
      if (value.reason !== undefined && typeof value.reason !== 'string') {
        throw bad('"reason" must be a string');
      }
      return typeof value.reason === 'string' && value.reason.trim()
        ? { decision: 'rejected', reason: value.reason }
        : { decision: 'rejected' };
    case 'stale': {
      const regions = value.currentRegions;
      if (!Array.isArray(regions)) throw bad('"currentRegions" must be an array');
      return {
        decision: 'stale',
        currentRegions: regions.map((r: unknown) => {
          if (!isRecord(r) || !Number.isInteger(r.index) || typeof r.text !== 'string') {
            throw bad('each region needs an integer "index" and a "text"');
          }
          return { index: r.index as number, text: r.text };
        }),
      };
    }
    default:
      throw bad('"decision" must be "accepted", "rejected" or "stale"');
  }
}

async function parseMessage(
  req: Request,
): Promise<{ text: string; messageId: string; snapshot?: EditorSnapshot }> {
  const body = (await req.json().catch(() => null)) as Partial<SendMessageRequest> | null;
  const text = body?.text;
  if (typeof text !== 'string' || !text.trim()) {
    throw new HttpError(400, '"text" must be a non-empty string');
  }
  const messageId = body?.messageId ?? crypto.randomUUID();
  if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) {
    throw new HttpError(400, '"messageId" must be 1-64 letters, digits, "-" or "_"');
  }
  if (body?.snapshot === undefined) return { text, messageId };
  return { text, messageId, snapshot: parseSnapshot(body.snapshot) };
}

/** Where a stream starts: Last-Event-ID (EventSource reconnect), else ?after, else 0. */
function startSeq(req: Request): number {
  const raw = req.headers.get('last-event-id') ?? new URL(req.url).searchParams.get('after') ?? '0';
  const seq = Number(raw);
  if (!Number.isInteger(seq) || seq < 0)
    throw new HttpError(400, 'Invalid Last-Event-ID or "after"');
  return seq;
}

/**
 * Long-lived SSE stream of a thread's channel. Stays open across runs; the client going away
 * (tab closed, reload) only unsubscribes this stream and never touches the run.
 */
function stream(thread: Thread, after: number, pingMs: number): Response {
  const encoder = new TextEncoder();
  let stop = () => {};

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          stop(); // the client is gone
        }
      };
      const send = (event: WireEvent) =>
        write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);

      // A comment first, so headers flush and EventSource reports the stream open at once.
      write(': connected\n\n');
      // A client ahead of the thread saw a previous server process (restart): start it over.
      let from = after;
      if (after > thread.lastSeq) {
        write('event: reset\ndata: {}\n\n');
        from = 0;
      }
      const unsubscribe = thread.subscribe(from, send);
      const ping = setInterval(() => write(': ping\n\n'), pingMs);
      stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        unsubscribe();
      };
    },
    cancel() {
      stop();
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

export function agentHandlers(
  threads: Threads,
  llm: Llm,
  projectRoot: string,
  { pingMs = PING_MS } = {},
) {
  return {
    /** GET /api/threads/:id/stream: every event of the thread, live, for as long as the tab is open. */
    stream: async (req: Request) => {
      const after = startSeq(req);
      const thread = await threads.getOrCreateThread(threadId(req));
      return stream(thread, after, pingMs);
    },

    /**
     * POST /api/threads/:id/messages { text, messageId? }: starts a run (202 { runId }) or
     * queues the message for the running agent (202 { queued: true }). Events go to the stream.
     */
    messages: async (req: Request) => {
      const id = threadId(req);
      const { text, messageId, snapshot } = await parseMessage(req);
      if (!(await llm.hasApiKey())) {
        const { id } = await llm.activeProvider();
        const body: NoApiKeyError = {
          error: 'no_api_key',
          envVar: llm.envVar(id),
          provider: llm.providerName(id),
        };
        return Response.json(body, { status: 400 });
      }
      const { runner, workspace } = await threads.getOrCreateThread(id);
      if (snapshot) workspace.setSnapshot(snapshot);
      if (runner.isRunning) {
        runner.steer(text, messageId);
        return Response.json({ queued: true } satisfies SendMessageResponse, { status: 202 });
      }
      const runId = runner.start(text, messageId);
      return Response.json({ runId } satisfies SendMessageResponse, { status: 202 });
    },

    /**
     * PUT /api/threads/:id/snapshot (an EditorSnapshot): the editor as the user sees it now.
     * The web app sends it during runs so the agent's view stays current (SPEC 5.7).
     */
    snapshot: async (req: Request) => {
      const id = threadId(req);
      const body: unknown = await req.json().catch(() => {
        throw new HttpError(400, 'Body must be JSON');
      });
      const snapshot = parseSnapshot(body);
      (await threads.getOrCreateThread(id)).workspace.setSnapshot(snapshot);
      return new Response(null, { status: 204 });
    },

    /**
     * POST /api/threads/:id/reviews/:toolCallId (a ReviewDecisionRequest): the user's decision
     * on a proposal. The first decision wins; later ones get 409 (SPEC 3.7). Every tab learns
     * the outcome from review_resolved on the stream.
     */
    review: async (req: Request) => {
      const id = threadId(req);
      const toolCallId = decodeURIComponent(new URL(req.url).pathname.split('/')[5] ?? '');
      if (!TOOL_CALL_ID.test(toolCallId)) throw new HttpError(400, 'Invalid tool call id');
      const body: unknown = await req.json().catch(() => {
        throw new HttpError(400, 'Body must be JSON');
      });
      const decision = parseDecision(body);
      const { pending } = await threads.getOrCreateThread(id);
      try {
        return Response.json(await decideReview(projectRoot, pending, toolCallId, decision));
      } catch (err) {
        if (err instanceof ReviewConflictError) {
          const conflict: ReviewConflictBody = { error: 'already_decided', message: err.message };
          return Response.json(conflict, { status: 409 });
        }
        if (err instanceof InvalidDecisionError) throw new HttpError(400, err.message);
        throw err;
      }
    },

    /** GET /api/threads: saved threads, most recently updated first (SPEC 5.4). */
    listThreads: async () =>
      Response.json((await threads.listThreads()) satisfies ThreadListResponse),

    /** POST /api/threads: a new, empty thread (201). */
    createThread: async () =>
      Response.json((await threads.createNewThread()) satisfies ThreadSummary, { status: 201 }),

    /**
     * GET /api/threads/:id/messages: what was saved before this server process loaded the
     * thread, as wire events. Load it first, then open the stream for the rest.
     */
    history: async (req: Request) => {
      const id = threadId(req);
      const exists = (await threads.sessions.load(id)) !== null;
      const thread = await threads.getOrCreateThread(id);
      if (!exists && thread.lastSeq === 0) throw new HttpError(404, `No thread ${id}`);
      const body: ThreadHistoryResponse = {
        thread: thread.record.summary(),
        events: thread.history(),
      };
      return Response.json(body);
    },

    /** DELETE /api/threads/:id: stops its run first, then deletes it. */
    deleteThread: async (req: Request) => {
      await threads.deleteThread(threadId(req));
      return new Response(null, { status: 204 });
    },

    /**
     * GET /api/threads/:id/status: whether a run is active. A client that expected events and
     * heard none checks this before giving up on a run (SPEC 8.3).
     */
    status: async (req: Request) => {
      const { runner } = await threads.getOrCreateThread(threadId(req));
      const body: ThreadStatusResponse = { running: runner.isRunning, runId: runner.runId };
      return Response.json(body);
    },

    /** POST /api/threads/:id/abort: stops the running agent; run_end arrives on the stream. */
    abort: async (req: Request) => {
      const { runner } = await threads.getOrCreateThread(threadId(req));
      return Response.json({ aborted: runner.abort() });
    },
  };
}
