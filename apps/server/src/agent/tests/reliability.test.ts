import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Message } from '@earendil-works/pi-ai';
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate';
import {
  fauxAssistantMessage,
  fauxThinking,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux';
import { LIST_FILES, type WireEvent } from '@phi/shared';

import { SAMPLE_MAIN } from '../../routes/tests/test-project.ts';
import { THREADS_DIR } from '../../services/sessions.ts';
import { contextEstimate, RESERVE_TOKENS, SUMMARY_OPEN } from '../compaction.ts';
import { createLlm, ROUTER_OUTPUT_TOKENS, type Llm } from '../llm.ts';
import { CONTINUE_REQUEST, MAX_CONTINUATIONS } from '../run.ts';
import { createWireContext, historyEvents } from '../wire.ts';
import { createThreads, type Thread } from '../threads.ts';

let root: string;
let llm: Llm;
const made: ReturnType<typeof createThreads>[] = [];

/** A server process: faux model with `contextWindow`, fast retries. */
function boot(contextWindow = 128_000) {
  llm = createLlm({ LLM_PROVIDER: 'faux' });
  // The faux model is a plain object; resolve() hands out the same one.
  (llm.model as { contextWindow: number }).contextWindow = contextWindow;
  const threads = createThreads({ projectRoot: root, llm, retry: { baseDelayMs: 1 } });
  made.push(threads);
  return threads;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reliability-test-'));
  cpSync(SAMPLE_MAIN, join(root, 'main.tex'));
});

afterEach(async () => {
  await Promise.all(made.splice(0).map((t) => t.flush().catch(() => {})));
  rmSync(root, { recursive: true, force: true });
});

// Text that pi's estimator counts as about n tokens.
const CHARS_PER_TOKEN = 40_000 / estimateTextTokens('x'.repeat(40_000));
const tokens = (n: number) => 'x'.repeat(Math.round(n * CHARS_PER_TOKEN));
const script = (...steps: FauxResponseStep[]) => llm.faux?.setResponses(steps);

/** Runs one message; resolves with every event of the run (run_end last). */
async function run(thread: Thread, text: string): Promise<WireEvent[]> {
  const events: WireEvent[] = [];
  const off = thread.subscribe(thread.lastSeq, (e) => events.push(e));
  thread.runner.start(text, crypto.randomUUID());
  await thread.runner.whenIdle();
  off();
  return events;
}

/** Shrinks the context window so `nextText` is just over the compaction threshold. */
function windowJustBelow(thread: Thread, nextText: string): number {
  const transcript = thread.agent.state.messages.filter((m) => m.role !== 'system');
  const window = contextEstimate(transcript, nextText) + RESERVE_TOKENS - 500;
  (llm.model as { contextWindow: number }).contextWindow = window;
  return window;
}

const ends = (events: WireEvent[]) => events.filter((e) => e.type === 'run_end');
const textOf = (m: Message) =>
  typeof m.content === 'string'
    ? m.content
    : m.content.map((c) => ('text' in c ? c.text : '')).join('');
const fileLines = (id: string) =>
  readFileSync(join(root, THREADS_DIR, `${id}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { type: string; firstKeptIndex?: number });

describe('compaction (SPEC 8.1)', () => {
  test('before a run that would come near the context window: summary + recent messages', async () => {
    const threads = boot();
    const thread = await threads.getOrCreateThread('t1');
    for (const n of [1, 2, 3, 4]) {
      script(fauxAssistantMessage(`ok ${n}`));
      expect(ends(await run(thread, `Turn ${n}: ${tokens(9000)}`))).toEqual([
        expect.objectContaining({ reason: 'done' }),
      ]);
    }

    const next = `Turn 5: ${tokens(9000)}`;
    const window = windowJustBelow(thread, next);
    let seen: Message[] = [];
    script(
      // The summarizer's request.
      fauxAssistantMessage('## Goal\nTurn 1 asked for things.\n## Decisions\nNone.'),
      (context) => {
        seen = context.messages;
        return fauxAssistantMessage('ok 5');
      },
    );
    const events = await run(thread, next);
    expect(events.map((e) => e.type)).toContain('compacted');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'status', message: 'Summarizing the conversation…' }),
    );
    expect(ends(events)).toEqual([expect.objectContaining({ reason: 'done' })]);

    // The request after compaction: system, summary, then turns 2-5 (turn 1 summarized).
    // The newest message carries the per-request <editor_state> block first (SPEC 5.7).
    const users = seen
      .filter((m) => m.role === 'user')
      .map((m) =>
        textOf(m)
          .replace(/^<editor_state>[\s\S]*?<\/editor_state>/, '')
          .slice(0, 25),
      );
    expect(users[0]).toStartWith(SUMMARY_OPEN);
    expect(users.slice(1).map((t) => t.slice(0, 6))).toEqual([
      'Turn 2',
      'Turn 3',
      'Turn 4',
      'Turn 5',
    ]);
    expect(seen.filter((m) => m.role === 'system')).toHaveLength(1);

    // On disk: a compaction line pointing at turn 2 (message index 2); nothing rewritten.
    await threads.flush();
    const compaction = fileLines('t1').find((l) => l.type === 'compaction');
    expect(compaction?.firstKeptIndex).toBe(2);
    expect(fileLines('t1').filter((l) => l.type === 'message')).toHaveLength(10);

    // After a restart the model sees the same; the history shows everything plus a divider.
    const restarted = await boot(window).getOrCreateThread('t1');
    const transcript = restarted.agent.state.messages.filter((m) => m.role !== 'system');
    expect(textOf(transcript[0] as Message)).toStartWith(SUMMARY_OPEN);
    expect(transcript).toHaveLength(1 + 8);
    const history = restarted.history().map((e) => e.type);
    expect(history.filter((t) => t === 'user_message')).toHaveLength(5);
    expect(history.indexOf('compacted')).toBe(history.lastIndexOf('user_message') - 0 - 1);
  });

  test('a request that overflows anyway: compact once and retry once', async () => {
    const threads = boot(); // the window looks big, but the provider disagrees
    const thread = await threads.getOrCreateThread('t1');
    for (const n of [1, 2, 3, 4]) {
      script(fauxAssistantMessage(`ok ${n}`));
      await run(thread, `Turn ${n}: ${tokens(9000)}`);
    }
    script(
      fauxAssistantMessage([], {
        stopReason: 'error',
        errorMessage: "This model's maximum context length is 32768 tokens.",
      }),
      fauxAssistantMessage('## Goal\nSummarized.'),
      fauxAssistantMessage('Recovered after compaction.'),
    );
    const events = await run(thread, 'Turn 5');
    expect(events.filter((e) => e.type === 'compacted')).toHaveLength(1);
    expect(ends(events)).toEqual([expect.objectContaining({ reason: 'done' })]);
    const last = thread.agent.state.messages.at(-1);
    expect(last && 'content' in last && JSON.stringify(last.content)).toContain(
      'Recovered after compaction.',
    );
  });

  test('a second overflow in the same run is not retried again', async () => {
    const threads = boot();
    const thread = await threads.getOrCreateThread('t1');
    for (const n of [1, 2, 3, 4]) {
      script(fauxAssistantMessage(`ok ${n}`));
      await run(thread, `Turn ${n}: ${tokens(9000)}`);
    }
    const overflow = fauxAssistantMessage([], {
      stopReason: 'error',
      errorMessage: 'maximum context length is 32768 tokens',
    });
    script(overflow, fauxAssistantMessage('## Goal\nS.'), overflow);
    const events = await run(thread, 'Turn 5');
    expect(ends(events)).toEqual([
      expect.objectContaining({
        reason: 'error',
        error: expect.stringContaining('maximum context length'),
      }),
    ]);
  });
});

describe('replies cut off at the output limit (SPEC 8.4)', () => {
  // The bug report: a long reasoning turn used all 4096 output tokens and the run just stopped.
  const cutOff = (thought: string) =>
    fauxAssistantMessage([fauxThinking(thought)], { stopReason: 'length' });
  const statuses = (events: WireEvent[]) =>
    events.filter((e) => e.type === 'status').map((e) => (e as { message: string }).message);

  test('the run continues where the reply stopped, with a visible status', async () => {
    const thread = await boot().getOrCreateThread('t1');
    script(cutOff('Long reasoning, part 1…'), fauxAssistantMessage('Here is the answer.'));
    const events = await run(thread, 'Explain the transformer section');
    expect(statuses(events)).toEqual(['Reply hit the output limit; continuing…']);
    expect(ends(events)).toEqual([expect.objectContaining({ reason: 'done' })]);
    const messages = thread.agent.state.messages.filter((m) => m.role !== 'system');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[2]).toMatchObject({ role: 'user', content: CONTINUE_REQUEST });
  });

  test('the added "continue" never shows as a user message, live or after a reload', async () => {
    const thread = await boot().getOrCreateThread('t1');
    script(cutOff('part 1'), fauxAssistantMessage('Done.'));
    const events = await run(thread, 'Hello');
    const typed = (list: { type: string; text?: string }[]) =>
      list.filter((e) => e.type === 'user_message').map((e) => e.text);
    expect(typed(events)).toEqual(['Hello']);
    const replay = historyEvents(
      thread.agent.state.messages,
      createWireContext(() => undefined),
    );
    expect(typed(replay)).toEqual(['Hello']);
  });

  test('still cut off after the continuations: the run ends with a clear notice', async () => {
    const thread = await boot().getOrCreateThread('t1');
    script(...Array.from({ length: MAX_CONTINUATIONS + 1 }, (_, i) => cutOff(`part ${i}`)));
    const events = await run(thread, 'Hello');
    expect(statuses(events)).toHaveLength(MAX_CONTINUATIONS);
    expect(ends(events)).toEqual([
      expect.objectContaining({
        reason: 'error',
        error: expect.stringContaining("cut off at the model's output limit"),
      }),
    ]);
  });

  test('Stop during a continued reply ends the run as stopped', async () => {
    const thread = await boot().getOrCreateThread('t1');
    script(cutOff('part 1'), (_context, options) => {
      thread.runner.abort();
      return fauxAssistantMessage([], {
        stopReason: options?.signal?.aborted ? 'aborted' : 'stop',
      });
    });
    const events = await run(thread, 'Hello');
    expect(ends(events)).toEqual([expect.objectContaining({ reason: 'aborted' })]);
  });

  test("OpenRouter's routers get a real output budget; other models keep their own", async () => {
    const stored = { apiKeys: {}, models: {}, recentProjects: [] as string[] };
    const router = createLlm({}, { read: async () => stored });
    // pi's catalog lists 4096, which a reasoning model can spend on thinking alone.
    expect(router.catalog('openrouter').length).toBeGreaterThan(0);
    expect((await router.resolve()).model).toMatchObject({
      id: 'openrouter/free',
      maxTokens: ROUTER_OUTPUT_TOKENS,
    });
    const claude = createLlm(
      {},
      { read: async () => ({ ...stored, provider: 'anthropic' as const }) },
    );
    expect((await claude.resolve()).model.maxTokens).toBe(128_000);
  });
});

describe('retries (SPEC 8.2)', () => {
  const transient = () =>
    fauxAssistantMessage([], { stopReason: 'error', errorMessage: '503 Service Unavailable' });

  test('transient errors are retried with a visible status; the failures never reach the transcript', async () => {
    const thread = await boot().getOrCreateThread('t1');
    script(transient(), transient(), fauxAssistantMessage('Third time lucky.'));
    const events = await run(thread, 'Hello');
    expect(
      events.filter((e) => e.type === 'status').map((e) => (e as { message: string }).message),
    ).toEqual(['Retrying (1/3)…', 'Retrying (2/3)…']);
    expect(ends(events)).toEqual([expect.objectContaining({ reason: 'done' })]);
    const roles = thread.agent.state.messages.filter((m) => m.role !== 'system').map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant']);
  });

  test('after 3 retries the run ends with the error', async () => {
    const thread = await boot().getOrCreateThread('t1');
    script(transient(), transient(), transient(), transient());
    const events = await run(thread, 'Hello');
    expect(events.filter((e) => e.type === 'status')).toHaveLength(3);
    expect(ends(events)).toEqual([
      expect.objectContaining({ reason: 'error', error: '503 Service Unavailable' }),
    ]);
  });

  test("quota errors are not retried: pi knows some, llm.ts knows the provider's", async () => {
    let thread = await boot().getOrCreateThread('t1');
    script(
      fauxAssistantMessage([], { stopReason: 'error', errorMessage: '429 insufficient_quota' }),
    );
    let events = await run(thread, 'Hello');
    expect(events.filter((e) => e.type === 'status')).toEqual([]);
    expect(ends(events)).toEqual([expect.objectContaining({ reason: 'error' })]);

    const threads = boot();
    // Read when the thread is created, as with OpenRouter's daily free-model quota.
    spyOn(llm, 'isPermanentError').mockReturnValue(true);
    thread = await threads.getOrCreateThread('t2');
    script(
      fauxAssistantMessage([], {
        stopReason: 'error',
        errorMessage: '429 rate limit: free-models-per-day',
      }),
    );
    events = await run(thread, 'Hello');
    expect(events.filter((e) => e.type === 'status')).toEqual([]);
  });

  test('Stop during the wait before a retry ends the run as stopped', async () => {
    const threads = createThreads({
      projectRoot: root,
      llm: (llm = createLlm({ LLM_PROVIDER: 'faux' })),
      retry: { baseDelayMs: 5_000 },
    });
    made.push(threads);
    const thread = await threads.getOrCreateThread('t1');
    script(transient(), fauxAssistantMessage('never'));
    const events: WireEvent[] = [];
    thread.subscribe(0, (e) => {
      events.push(e);
      if (e.type === 'status') thread.runner.abort();
    });
    thread.runner.start('Hello', 'm1');
    await thread.runner.whenIdle();
    expect(ends(events)).toEqual([expect.objectContaining({ reason: 'aborted' })]);
  });
});

describe('every run ends with exactly one run_end (SPEC 8.3)', () => {
  async function expectOneEnd(thread: Thread, events: WireEvent[], reason: string) {
    expect(ends(events)).toEqual([expect.objectContaining({ reason })]);
    expect(thread.runner.isRunning).toBe(false);
    expect(thread.runner.runId).toBeNull();
  }

  test('model resolution fails before the run (bad model in Settings)', async () => {
    const thread = await boot().getOrCreateThread('t1');
    spyOn(llm, 'resolve').mockRejectedValue(
      new Error('The model in Settings "x" is not in the catalog'),
    );
    const events = await run(thread, 'Hello');
    await expectOneEnd(thread, events, 'error');
    expect(ends(events)[0]).toMatchObject({ error: expect.stringContaining('not in the catalog') });
  });

  test('compaction fails (the summarizer errors)', async () => {
    const threads = boot();
    const thread = await threads.getOrCreateThread('t1');
    for (const n of [1, 2, 3, 4]) {
      script(fauxAssistantMessage(`ok ${n}`));
      await run(thread, `Turn ${n}: ${tokens(9000)}`);
    }
    const next = `Turn 5: ${tokens(9000)}`;
    windowJustBelow(thread, next);
    script(fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'summarizer down' }));
    const events = await run(thread, next);
    await expectOneEnd(thread, events, 'error');
    expect(ends(events)[0]).toMatchObject({
      error: expect.stringContaining('Could not summarize'),
    });
  });

  test('a tool throws: the model gets the error, the run finishes', async () => {
    const thread = await boot().getOrCreateThread('t1');
    const tool = thread.agent.state.tools.find((t) => t.name === LIST_FILES)!;
    spyOn(tool, 'execute').mockRejectedValue(new Error('disk on fire'));
    script(fauxAssistantMessage(fauxToolCall(LIST_FILES, {})), fauxAssistantMessage('Sorry.'));
    await expectOneEnd(thread, await run(thread, 'List files'), 'done');
  });

  test('persistence fails: logged, the run still ends', async () => {
    const threads = boot();
    const thread = await threads.getOrCreateThread('t1');
    spyOn(threads.sessions, 'create').mockRejectedValue(new Error('disk full'));
    const error = spyOn(console, 'error').mockImplementation(() => {});
    script(fauxAssistantMessage('Hi.'));
    await expectOneEnd(thread, await run(thread, 'Hello'), 'done');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Could not save thread t1'),
      expect.anything(),
    );
    await threads.flush(); // later saves of this run fail too; keep them quiet
    error.mockRestore();
  });

  test('an event listener throws mid-run', async () => {
    const thread = await boot().getOrCreateThread('t1');
    thread.agent.subscribe((event) => {
      if (event.type === 'message_end' && event.message.role === 'assistant')
        throw new Error('listener bug');
    });
    script(fauxAssistantMessage('Hi.'));
    const events = await run(thread, 'Hello');
    expect(ends(events)).toHaveLength(1);
    expect(thread.runner.isRunning).toBe(false);
  });

  test('the stream function itself throws', async () => {
    const threads = boot();
    llm.streamFn = () => {
      throw new Error('socket exploded');
    };
    const thread = await threads.getOrCreateThread('t1');
    const events = await run(thread, 'Hello');
    await expectOneEnd(thread, events, 'error');
    expect(ends(events)[0]).toMatchObject({ error: expect.stringContaining('socket exploded') });
  });
});
