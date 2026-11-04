import type { Agent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { RunEndEvent, UnsequencedWireEvent } from '@phi/shared';

import type { TurnLimit } from './turn-limit.ts';

type Publish = (event: UnsequencedWireEvent) => void;

/**
 * Sent (hidden from the chat) when a reply stopped at the model's output limit, often in the
 * middle of its reasoning, so the model picks up where it stopped instead of the run ending.
 */
export const CONTINUE_REQUEST =
  'Your previous reply was cut off by the output limit. Continue exactly where you stopped; ' +
  'do not repeat what you already wrote. Be more concise in your reasoning.';

/** How many times a run continues after a cut-off reply before it gives up. */
export const MAX_CONTINUATIONS = 2;

const cutOffMessage = (tokens: number | undefined) =>
  `The reply was cut off at the model's output limit${tokens ? ` (${tokens} tokens)` : ''}, ` +
  'even after continuing. Say "continue", or pick a model with a larger output limit in Settings.';

export interface Runner {
  readonly isRunning: boolean;
  /** Publishes the user's message and run_start, then runs the agent. Returns the runId. */
  start(text: string, messageId: string): string;
  /** Publishes the message as queued and hands it to the agent for its next turn. */
  steer(text: string, messageId: string): void;
  /** Aborts the current run; false if nothing was running. */
  abort(): boolean;
  /** Resolves once no run is active (after its run_end was published). */
  whenIdle(): Promise<void>;
  /** The active run's id, or null when idle (GET /status, SPEC 8.3). */
  readonly runId: string | null;
}

export interface RunHooks {
  /** Runs before the run's first request (model from Settings, compaction). Throwing fails the run. */
  beforeRun?: (text: string) => Promise<void>;
  /**
   * Called once per run when a request failed; true when it fixed the cause (compacted after
   * a context overflow), so the run continues once more.
   */
  recover?: (failed: AssistantMessage) => Promise<boolean>;
}

/**
 * Owns one thread's run lifecycle. pi events reach the channel through wire.ts; this adds
 * the events pi doesn't have: user_message, run_start and run_end.
 */
export function createRunner(
  agent: Agent,
  publish: Publish,
  turnLimit?: Pick<TurnLimit, 'startRun' | 'reached'>,
  hooks: RunHooks = {},
): Runner {
  let running = false;
  let abortRequested = false;
  let runId: string | null = null;
  let current: Promise<void> = Promise.resolve();

  const lastAssistant = () =>
    agent.state.messages.findLast((m): m is AssistantMessage => m.role === 'assistant');

  /** How the run ended. Never throws: run_end must always go out (SPEC 8.3). */
  function endEvent(error?: unknown): Omit<RunEndEvent, 'seq'> {
    try {
      return describeEnd(error);
    } catch (err) {
      return {
        type: 'run_end',
        reason: 'error',
        error: `The run ended unexpectedly: ${String(err)}`,
      };
    }
  }

  function describeEnd(error?: unknown): Omit<RunEndEvent, 'seq'> {
    if (abortRequested) return { type: 'run_end', reason: 'aborted' };
    if (error !== undefined) {
      return {
        type: 'run_end',
        reason: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const last = lastAssistant();
    if (last?.stopReason === 'aborted') return { type: 'run_end', reason: 'aborted' };
    if (last?.stopReason === 'error') {
      const message =
        last.errorMessage ?? agent.state.errorMessage ?? 'The model returned an error';
      return { type: 'run_end', reason: 'error', error: message };
    }
    if (last?.stopReason === 'length') {
      return { type: 'run_end', reason: 'error', error: cutOffMessage(last.usage?.output) };
    }
    return { type: 'run_end', reason: 'done' };
  }

  async function run(text: string): Promise<void> {
    let failure: unknown;
    let recovered = false;
    let continuations = 0;
    try {
      await hooks.beforeRun?.(text);
      await agent.prompt(text);
      for (;;) {
        if (abortRequested) break;
        const last = lastAssistant();
        // Once per run: e.g. the context overflowed, it was compacted, try again.
        if (!recovered && last?.stopReason === 'error' && hooks.recover) {
          recovered = true;
          if (await hooks.recover(last)) {
            await agent.continue();
            continue;
          }
        }
        // Cut off at the output limit (often mid-reasoning): ask the model to go on, a few times.
        if (
          last?.stopReason === 'length' &&
          continuations < MAX_CONTINUATIONS &&
          !turnLimit?.reached
        ) {
          continuations++;
          publish({ type: 'status', message: 'Reply hit the output limit; continuing…' });
          agent.followUp({ role: 'user', content: CONTINUE_REQUEST, timestamp: Date.now() });
          await agent.continue();
          continue;
        }
        // A steer that lands as the last turn ends is still queued; keep going in this run,
        // unless the turn limit ended it (the message then waits for the next run).
        if (!turnLimit?.reached && agent.hasQueuedMessages()) {
          await agent.continue();
          continue;
        }
        break;
      }
    } catch (err) {
      failure = err;
    } finally {
      running = false;
      runId = null;
      publish(endEvent(failure));
    }
  }

  return {
    get isRunning() {
      return running;
    },

    start(text, messageId) {
      if (running) throw new Error('A run is already active on this thread');
      running = true;
      abortRequested = false;
      turnLimit?.startRun();
      const id = crypto.randomUUID();
      runId = id;
      publish({ type: 'user_message', messageId, text, queued: false });
      publish({ type: 'run_start', runId: id });
      current = run(text);
      return id;
    },

    steer(text, messageId) {
      publish({ type: 'user_message', messageId, text, queued: true });
      agent.steer({ role: 'user', content: text, timestamp: Date.now() });
    },

    whenIdle() {
      return current;
    },

    get runId() {
      return runId;
    },

    abort() {
      if (!running) return false;
      abortRequested = true;
      agent.clearAllQueues();
      agent.abort();
      return true;
    },
  };
}
