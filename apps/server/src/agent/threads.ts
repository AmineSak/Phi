import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core';
import { isContextOverflow } from '@earendil-works/pi-ai';
import type { ThreadSummary, UnsequencedWireEvent, WireEvent } from '@phi/shared';

import { createSessionStore } from '../services/sessions.ts';
import {
  contextEstimate,
  cutIndex,
  needsCompaction,
  summarize,
  summaryMessage,
} from './compaction.ts';
import { editorStateTransform } from './editor-state.ts';
import type { Llm } from './llm.ts';
import { createPending, type Pending } from './pending.ts';
import { persistThread, storedMessages, type ThreadRecord } from './persistence.ts';
import { preambleGuard } from './policy.ts';
import { buildSystemPrompt } from './prompt.ts';
import { withRetry } from './retry.ts';
import { createRunner, type Runner } from './run.ts';
import { createProjectTools } from './tools/index.ts';
import { createTurnLimit } from './turn-limit.ts';
import { missingToolResults } from './transcript.ts';
import { attachWire, createWireContext, historyEvents } from './wire.ts';
import { createWorkspace, type Workspace } from './workspace.ts';

/** Events kept per thread so tabs that connect or reconnect can catch up. */
export const MAX_BUFFERED_EVENTS = 2000;

export type WireListener = (event: WireEvent) => void;

/** A thread's event channel, shared by every open tab. */
export interface Channel {
  /** Assigns the next seq, buffers the event and delivers it to every subscriber. */
  publish(event: UnsequencedWireEvent): WireEvent;
  /** Replays buffered events with seq > afterSeq, then delivers live ones. Returns unsubscribe. */
  subscribe(afterSeq: number, listener: WireListener): () => void;
  /** Seq of the last published event (0 before the first). */
  readonly lastSeq: number;
}

export function createChannel(): Channel {
  let seq = 0;
  const buffer: WireEvent[] = [];
  const listeners = new Set<WireListener>();

  const deliver = (listener: WireListener, event: WireEvent) => {
    try {
      listener(event);
    } catch (err) {
      // One broken subscriber (e.g. a closed stream) must not starve the others.
      listeners.delete(listener);
      console.error('Dropped a thread subscriber that threw:', err);
    }
  };

  return {
    publish(event) {
      const sequenced = { ...event, seq: ++seq } as WireEvent;
      buffer.push(sequenced);
      if (buffer.length > MAX_BUFFERED_EVENTS) buffer.shift();
      for (const listener of [...listeners]) deliver(listener, sequenced);
      return sequenced;
    },
    subscribe(afterSeq, listener) {
      for (const event of buffer) if (event.seq > afterSeq) deliver(listener, event);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get lastSeq() {
      return seq;
    },
  };
}

export interface Thread extends Channel {
  id: string;
  agent: Agent;
  /** Starts, steers and stops runs; publishes run_start, run_end and user_message. */
  runner: Runner;
  /** The editor as the user last showed it, overlaid on the files on disk. */
  workspace: Workspace;
  /** Proposals waiting for the user's review. */
  pending: Pending;
  /** Saves the transcript; knows the title and totals. */
  record: ThreadRecord;
  /** What was on disk when the thread loaded, as wire events; the stream carries the rest. */
  history: () => UnsequencedWireEvent[];
}

export interface ThreadDeps {
  projectRoot: string;
  llm: Llm;
  /** Turns per run before the summary turn ends it (SPEC 2.3); tests lower it. */
  maxTurns?: number;
  /** Time before an undecided proposal is cancelled (SPEC 3.8); tests lower it. */
  reviewTimeoutMs?: number;
  /** Retry policy for transient provider errors (SPEC 8.2); tests shorten the waits. */
  retry?: { maxRetries?: number; baseDelayMs?: number };
}

export type Threads = ReturnType<typeof createThreads>;

/** One pi Agent and one event channel per chat thread, created on first use. */
export function createThreads({ projectRoot, llm, maxTurns, reviewTimeoutMs, retry }: ThreadDeps) {
  // Promises, so two concurrent first requests for a thread share one Agent.
  const threads = new Map<string, Promise<Thread>>();

  const sessions = createSessionStore(projectRoot);
  // Saves and title writes still running after a run ended.
  const background = new Set<Promise<void>>();
  const track = (work: Promise<void>) => {
    background.add(work);
    void work.finally(() => background.delete(work));
  };

  async function createThread(id: string): Promise<Thread> {
    const stored = await sessions.load(id);
    const raw = storedMessages((stored?.messages ?? []) as AgentMessage[]);
    // The model sees the latest summary, then the messages kept after it (SPEC 8.1).
    const compaction = stored?.compactions.at(-1);
    const loaded = compaction
      ? [summaryMessage(compaction.summary), ...raw.slice(compaction.firstKeptIndex)]
      : raw;
    // The server stopped mid-run (maybe during a review): answer the dangling tool calls.
    const repairs = missingToolResults(loaded);
    if (stored && repairs.length > 0) await sessions.append(id, repairs);
    const messages = [...loaded, ...repairs];
    const history = [...raw, ...repairs];

    const channel = createChannel();
    const workspace = createWorkspace(projectRoot);
    // Every tab drops a proposal from its queue when its review ends, however it ends.
    const pending = createPending({
      timeoutMs: reviewTimeoutMs,
      onSettled: (toolCallId, decision) =>
        channel.publish({ type: 'review_resolved', toolCallId, decision }),
    });
    const tools = createProjectTools(projectRoot, workspace, pending);
    const turnLimit = createTurnLimit(maxTurns);
    const guard = preambleGuard(workspace);
    const agent = new Agent({
      initialState: {
        // Stored messages have no system message: pi adds the current prompt and tools.
        systemPrompt: await buildSystemPrompt({ projectRoot, tools }),
        // The startup model; each run switches to the current one (beforeRun below).
        model: llm.model,
        tools: tools.map((t) => t.tool),
        messages,
      },
      // Transient provider errors are retried, visibly (SPEC 8.2).
      streamFn: withRetry(llm.streamFn, {
        maxRetries: retry?.maxRetries,
        baseDelayMs: retry?.baseDelayMs,
        isPermanent: llm.isPermanentError,
        onRetry: (attempt, max) =>
          channel.publish({ type: 'status', message: `Retrying (${attempt}/${max})…` }),
      }),
      // Read per request, so a key set in Settings applies without a restart (SPEC 7.1).
      getApiKey: (provider) => llm.apiKey(provider),
      sessionId: id,
      // Per request only: the block never enters agent.state.messages (SPEC 5.7).
      transformContext: editorStateTransform(projectRoot, workspace),
      beforeToolCall: async (ctx) => turnLimit.blockOnLastTurn() ?? (await guard(ctx)),
      finishTurn: () => turnLimit.finishTurn(),
      prepareNextTurn: () => turnLimit.prepareNextTurn(),
    });

    const record = persistThread(id, agent, sessions, stored, {
      persisted: messages.length,
      rawCount: history.length,
    });

    /**
     * Replaces older messages with a summary when the next request would come near the
     * context window (or did overflow it, `force`). True when it compacted.
     */
    async function compact(newText: string, force = false): Promise<boolean> {
      await record.save();
      const transcript = storedMessages(agent.state.messages);
      const model = agent.state.model;
      if (!force && !needsCompaction(contextEstimate(transcript, newText), model.contextWindow)) {
        return false;
      }
      const cut = cutIndex(transcript);
      if (cut === null) return false;
      channel.publish({ type: 'status', message: 'Summarizing the conversation…' });
      const summary = await summarize(llm, model, transcript.slice(0, cut), agent.signal);
      // A request that failed (e.g. on the overflow) is not worth keeping in front of the model.
      const kept = transcript.slice(cut);
      const live = force
        ? kept.filter((m) => m.role !== 'assistant' || m.stopReason !== 'error')
        : kept;
      const system = agent.state.messages.filter((m) => m.role === 'system');
      agent.state.messages = [...system, summaryMessage(summary), ...live];
      await record.compacted(summary, kept.length);
      channel.publish({ type: 'compacted', summary });
      return true;
    }

    // Each finished message is saved at once, so a restart loses at most the one in progress.
    // Saves queue up in order without holding the agent back; agent_end waits for them all.
    agent.subscribe((event) => {
      if (event.type === 'message_end') void record.save();
      if (event.type === 'agent_end') return record.save();
    });
    // run_end comes after aborts and errors too: save what is left, then name a new thread.
    channel.subscribe(channel.lastSeq, (event) => {
      if (event.type !== 'run_end') return;
      track(
        record.save().then(async () => {
          if (await record.nameIfUntitled()) {
            channel.publish({ type: 'thread_updated', threadId: id, title: record.title });
          }
        }),
      );
    });

    attachWire(agent, channel.publish);
    const toolLabel = (name: string) => agent.state.tools.find((t) => t.name === name)?.label;
    return {
      id,
      agent,
      workspace,
      pending,
      record,
      history: () =>
        historyEvents(history, createWireContext(toolLabel), stored?.compactions ?? []),
      runner: createRunner(agent, channel.publish, turnLimit, {
        beforeRun: async (text) => {
          // A model chosen in Settings applies from the next run on.
          const { model, thinkingLevel } = await llm.resolve();
          agent.state.model = model;
          agent.state.thinkingLevel = thinkingLevel;
          await compact(text);
        },
        // The request overflowed the context anyway: compact once and try again (SPEC 8.1).
        recover: async (failed) =>
          isContextOverflow(failed, agent.state.model.contextWindow) && (await compact('', true)),
      }),
      publish: channel.publish,
      subscribe: channel.subscribe,
      get lastSeq() {
        return channel.lastSeq;
      },
    };
  }

  function getOrCreateThread(threadId: string): Promise<Thread> {
    let thread = threads.get(threadId);
    if (!thread) {
      thread = createThread(threadId);
      threads.set(threadId, thread);
      thread.catch(() => threads.delete(threadId));
    }
    return thread;
  }

  /** Creates and saves a new, empty thread. */
  async function createNewThread(): Promise<ThreadSummary> {
    const thread = await getOrCreateThread(crypto.randomUUID());
    await thread.record.create();
    return thread.record.summary();
  }

  /** Saved threads, most recent first; threads in memory report their live title and totals. */
  async function listThreads(): Promise<ThreadSummary[]> {
    const saved = await sessions.list();
    return Promise.all(
      saved.map(async (summary) => {
        const live = threads.get(summary.id);
        return live ? (await live).record.summary() : summary;
      }),
    );
  }

  /** Stops the thread's run (and reviews), tells its tabs, and deletes its file. */
  async function deleteThread(threadId: string): Promise<void> {
    const live = threads.get(threadId);
    if (live) {
      const thread = await live;
      thread.runner.abort();
      await thread.runner.whenIdle();
      // Let the aborted run's save and title land before the thread is announced gone.
      await Promise.all([...background]);
      await thread.record.close();
      thread.publish({ type: 'thread_updated', threadId, deleted: true });
      threads.delete(threadId);
    }
    await sessions.remove(threadId);
  }

  /** Waits for every pending write (tests, shutdown). */
  async function flush(): Promise<void> {
    await Promise.all([...background]);
    for (const thread of threads.values()) await (await thread).record.close();
  }

  /** Stops every run (which also ends pending reviews) and saves what is left (SPEC 4.4). */
  async function closeAll(): Promise<void> {
    for (const live of threads.values()) {
      const thread = await live;
      thread.runner.abort();
      await thread.runner.whenIdle();
    }
    await flush();
    threads.clear();
  }

  return {
    getOrCreateThread,
    createNewThread,
    listThreads,
    deleteThread,
    flush,
    closeAll,
    sessions,
  };
}
