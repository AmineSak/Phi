import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { Message, UserMessage } from '@earendil-works/pi-ai';
import type { FauxResponseStep } from '@earendil-works/pi-ai/providers/faux';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import {
  LIST_FILES,
  MAX_SELECTION_CHARS,
  READ_FILE,
  type EditorSnapshot,
  type WireEvent,
} from '@phi/shared';

import { createLlm, type Llm } from '../../agent/llm.ts';
import { createThreads } from '../../agent/threads.ts';
import { agentHandlers, parseSnapshot } from '../agent.ts';
import { guard } from '../security.ts';
import { tempProject } from './test-project.ts';

const PING_MS = 20;

let project: ReturnType<typeof tempProject>;
let llm: Llm;
let server: ReturnType<typeof Bun.serve>;
let base: string;

function startServer(model: Llm) {
  const agent = agentHandlers(
    createThreads({ projectRoot: project.root, llm: model }),
    model,
    project.root,
    { pingMs: PING_MS },
  );
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    fetch: () => new Response(),
  });
  const port = server.port ?? 0;
  base = `http://127.0.0.1:${port}/api/threads`;
  server.reload({
    routes: {
      '/api/threads/:id/messages': { POST: guard(agent.messages, port) },
      '/api/threads/:id/abort': { POST: guard(agent.abort, port) },
      '/api/threads/:id/snapshot': { PUT: guard(agent.snapshot, port) },
      '/api/threads/:id/stream': { GET: guard(agent.stream, port) },
    },
    fetch: () => new Response('Not found', { status: 404 }),
  });
}

beforeEach(() => {
  project = tempProject();
  llm = createLlm({ LLM_PROVIDER: 'faux' });
  startServer(llm);
});

afterEach(async () => {
  await server.stop(true);
  project.remove();
});

const script = (...steps: FauxResponseStep[]) => llm.faux?.setResponses(steps);

const post = (thread: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/${thread}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const open = (thread: string, query = '', headers: Record<string, string> = {}) =>
  fetch(`${base}/${thread}/stream${query}`, { headers }).then(readSse);

function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  return { release, opened };
}

/** Incremental SSE reader: checks `id:` matches the event's seq and counts `: ping` comments. */
function readSse(res: Response) {
  expect(res.headers.get('content-type')).toBe('text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let pings = 0;

  async function next(): Promise<WireEvent | null> {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end === -1) {
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
        continue;
      }
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (frame.startsWith(':')) {
        if (frame === ': ping') pings++;
        continue;
      }
      const id = /^id: (\d+)$/m.exec(frame)?.[1];
      const event = JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? 'null') as WireEvent;
      expect(id).toBe(String(event.seq));
      return event;
    }
  }

  /** Reads events up to and including the first of `type`. */
  async function until(type: WireEvent['type']): Promise<WireEvent[]> {
    const events: WireEvent[] = [];
    for (let e = await next(); e; e = await next()) {
      events.push(e);
      if (e.type === type) return events;
    }
    throw new Error(`stream ended before ${type}; got ${events.map((x) => x.type).join(', ')}`);
  }

  return { next, until, pings: () => pings, close: () => reader.cancel() };
}

/** Event types, with runs of deltas collapsed. */
const shape = (events: WireEvent[]) =>
  events
    .map((e) => e.type)
    .filter((type, i, all) => !(type.endsWith('_delta') && all[i - 1] === type));

const textOf = (events: WireEvent[]) =>
  events.map((e) => (e.type === 'text_delta' ? e.delta : '')).join('');

describe('POST /messages + GET /stream', () => {
  test('a run: 202 { runId } and the whole run on the stream, with usage', async () => {
    script(fauxAssistantMessage(fauxToolCall(LIST_FILES, {})), fauxAssistantMessage('One file.'));
    const stream = await open('t1');

    const res = await post('t1', { text: 'What files are there?', messageId: 'm-1' });
    expect(res.status).toBe(202);
    expect(res.headers.get('content-type')).toContain('application/json');
    const { runId } = (await res.json()) as { runId: string };

    const events = await stream.until('run_end');
    expect(shape(events)).toEqual([
      'user_message',
      'run_start',
      'turn_start',
      'message_end',
      'tool_start',
      'tool_end',
      'turn_end',
      'turn_start',
      'text_delta',
      'message_end',
      'turn_end',
      'run_end',
    ]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events[0]).toMatchObject({
      messageId: 'm-1',
      text: 'What files are there?',
      queued: false,
    });
    expect(events[1]).toMatchObject({ type: 'run_start', runId });
    expect(events.find((e) => e.type === 'tool_start')).toMatchObject({ label: 'List files' });
    for (const end of events.filter((e) => e.type === 'message_end')) {
      expect(end).toMatchObject({
        usage: {
          input: expect.any(Number),
          output: expect.any(Number),
          cacheRead: expect.any(Number),
          cacheWrite: expect.any(Number),
          costUsd: expect.any(Number),
        },
      });
    }
    expect(textOf(events)).toBe('One file.');
    expect(events.at(-1)).toMatchObject({ type: 'run_end', reason: 'done' });
  });

  test('two subscribers receive every event in the same order', async () => {
    script(fauxAssistantMessage(fauxToolCall(LIST_FILES, {})), fauxAssistantMessage('Done.'));
    const [tabA, tabB] = await Promise.all([open('t1'), open('t1')]);
    await post('t1', { text: 'Go' });
    const [a, b] = await Promise.all([tabA.until('run_end'), tabB.until('run_end')]);
    expect(a.length).toBeGreaterThan(5);
    expect(b).toEqual(a);
  });

  test('the stream stays open across runs, and seq keeps counting', async () => {
    script(fauxAssistantMessage('First.'), fauxAssistantMessage('Second.'));
    const stream = await open('t1');
    await post('t1', { text: 'one' });
    const first = await stream.until('run_end');
    await post('t1', { text: 'two' });
    const second = await stream.until('run_end');
    expect(second[0]?.seq).toBe((first.at(-1)?.seq ?? 0) + 1);
    expect(textOf(second)).toBe('Second.');
  });

  test('a message sent mid-run is queued (202 { queued: true }) and shown as queued', async () => {
    const hold = gate();
    let secondRequest: string[] = [];
    script(
      async () => {
        await hold.opened;
        return fauxAssistantMessage('First answer.');
      },
      (context) => {
        secondRequest = context.messages
          .filter((m): m is UserMessage => m.role === 'user')
          .map((m) =>
            typeof m.content === 'string'
              ? m.content
              : m.content
                  .map((c) =>
                    c.type === 'text' && !c.text.startsWith('<editor_state>') ? c.text : '',
                  )
                  .join(''),
          );
        return fauxAssistantMessage('Answer to the follow-up.');
      },
    );
    const stream = await open('t1');
    await post('t1', { text: 'Fix the intro.' });
    await stream.until('turn_start');

    const steer = await post('t1', { text: 'Also check the bibliography.', messageId: 'm-2' });
    expect(steer.status).toBe(202);
    expect(await steer.json()).toEqual({ queued: true });
    hold.release();

    const rest = await stream.until('run_end');
    expect(rest[0]).toMatchObject({ type: 'user_message', messageId: 'm-2', queued: true });
    expect(rest.filter((e) => e.type === 'run_start')).toEqual([]);
    expect(textOf(rest)).toBe('First answer.Answer to the follow-up.');
    expect(secondRequest).toEqual(['Fix the intro.', 'Also check the bibliography.']);
  });

  test('abort mid-run ends the run with reason aborted; the thread can run again', async () => {
    const requested = gate();
    script(
      (_context, options) =>
        new Promise((resolve) => {
          options?.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('late')));
          requested.release();
        }),
      fauxAssistantMessage('Fresh run.'),
    );
    const stream = await open('t1');
    await post('t1', { text: 'Write a chapter' });
    // Abort once the model request is in flight, not while the context is still prepared.
    await requested.opened;

    const abort = await fetch(`${base}/t1/abort`, { method: 'POST' });
    expect(await abort.json()).toEqual({ aborted: true });
    expect((await stream.until('run_end')).at(-1)).toMatchObject({ reason: 'aborted' });

    await post('t1', { text: 'Again' });
    expect(textOf(await stream.until('run_end'))).toBe('Fresh run.');
  });

  test('abort with nothing running is a no-op', async () => {
    const res = await fetch(`${base}/idle/abort`, { method: 'POST' });
    expect(await res.json()).toEqual({ aborted: false });
  });

  test('pings keep the stream alive while idle', async () => {
    const stream = await open('t1');
    await Bun.sleep(PING_MS * 4);
    script(fauxAssistantMessage('ok'));
    await post('t1', { text: 'hi' });
    await stream.until('run_end');
    expect(stream.pings()).toBeGreaterThan(0);
  });
});

describe('resuming', () => {
  test('Last-Event-ID, else ?after, else 0, picks the starting point', async () => {
    script(fauxAssistantMessage('Done.'));
    const live = await open('t1');
    await post('t1', { text: 'Hi' });
    const all = await live.until('run_end');

    const fromZero = await open('t1');
    expect(await fromZero.until('run_end')).toEqual(all);

    const afterTwo = await open('t1', '?after=2');
    expect(await afterTwo.until('run_end')).toEqual(all.slice(2));

    const header = await open('t1', '?after=0', { 'Last-Event-ID': '3' });
    expect(await header.until('run_end')).toEqual(all.slice(3));
  });

  test('a dropped stream does not stop the run; reconnecting continues with nothing lost', async () => {
    const hold = gate();
    script(async () => {
      await hold.opened;
      return fauxAssistantMessage('Still here after the reload.');
    });
    const first = await open('t1');
    await post('t1', { text: 'Long task' });
    const seen = await first.until('turn_start');
    await first.close();

    const resumed = await open('t1', '', { 'Last-Event-ID': String(seen.at(-1)?.seq) });
    hold.release();
    const rest = await resumed.until('run_end');
    expect(rest[0]?.seq).toBe((seen.at(-1)?.seq ?? 0) + 1);
    expect(textOf(rest)).toBe('Still here after the reload.');
    expect(rest.at(-1)).toMatchObject({ reason: 'done' });
  });
});

describe('server restart', () => {
  test('a client ahead of the thread gets a reset event and a replay from the start', async () => {
    script(fauxAssistantMessage('Done.'));
    const live = await open('t1');
    await post('t1', { text: 'Hi' });
    await live.until('run_end');

    const res = await fetch(`${base}/t1/stream`, { headers: { 'Last-Event-ID': '999' } });
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('"run_end"'))
      text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    const reset = text.indexOf('event: reset\ndata: {}\n\n');
    expect(reset).toBeGreaterThan(-1);
    expect(text.indexOf('id: 1\n')).toBeGreaterThan(reset);
  });
});

describe('validation', () => {
  test('no API key: 400 no_api_key with the variable to set, and no run starts', async () => {
    await server.stop(true);
    const keyless = createLlm({}); // OpenRouter by default, no OPENROUTER_API_KEY
    startServer(keyless);
    const stream = await open('t1');
    const res = await post('t1', { text: 'Hi' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'no_api_key',
      envVar: 'OPENROUTER_API_KEY',
      provider: 'OpenRouter',
    });

    const nothing = await Promise.race([
      stream.next(),
      Bun.sleep(100).then(() => 'quiet' as const),
    ]);
    expect(nothing).toBe('quiet');
  });

  test('rejects bad input and foreign origins', async () => {
    expect((await post('bad id!', { text: 'x' })).status).toBe(400);
    expect((await post('t1', { text: '   ' })).status).toBe(400);
    expect((await post('t1', { text: 42 })).status).toBe(400);
    expect((await post('t1', { text: 'x', messageId: 'has spaces' })).status).toBe(400);
    expect((await post('t1', { text: 'x' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(`${base}/t1/stream?after=-1`)).status).toBe(400);
    expect(
      (await fetch(`${base}/t1/stream`, { headers: { origin: 'https://evil.example' } })).status,
    ).toBe(403);
  });
});

describe('editor snapshot (SPEC 5.7)', () => {
  const snapshot = (over: Partial<EditorSnapshot> = {}): EditorSnapshot => ({
    activeFile: 'main.tex',
    cursorLine: 3,
    dirtyFiles: [],
    revertedToolCallIds: [],
    ...over,
  });

  const put = (thread: string, body: unknown) =>
    fetch(`${base}/${thread}/snapshot`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const userText = (messages: Message[]) => {
    const user = messages.findLast((m): m is UserMessage => m.role === 'user');
    if (!user) return '';
    return typeof user.content === 'string'
      ? user.content
      : user.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  };

  test('a message carries the snapshot: the agent reads the unsaved line 3', async () => {
    const lines = (await Bun.file(`${project.root}/main.tex`).text()).split('\n');
    lines[2] = 'This third line is typed but not saved.';
    let toolOutput = '';
    script(
      fauxAssistantMessage(fauxToolCall(READ_FILE, { path: 'main.tex', offset: 3, limit: 1 })),
      (context) => {
        const result = context.messages.findLast((m) => m.role === 'toolResult');
        toolOutput = result?.role === 'toolResult' ? JSON.stringify(result.content) : '';
        return fauxAssistantMessage('Line 3 says it is not saved.');
      },
    );
    const stream = await open('t1');
    const res = await post('t1', {
      text: 'What does line 3 of main.tex say?',
      snapshot: snapshot({ dirtyFiles: [{ path: 'main.tex', content: lines.join('\n') }] }),
    });
    expect(res.status).toBe(202);
    await stream.until('run_end');
    expect(toolOutput).toContain('This third line is typed but not saved.');
  });

  test('PUT /snapshot during a run updates what the next request sees', async () => {
    const hold = gate();
    const requests: string[] = [];
    script(
      async (context) => {
        requests.push(userText(context.messages));
        await hold.opened;
        return fauxAssistantMessage(fauxToolCall(LIST_FILES, {}));
      },
      (context) => {
        requests.push(userText(context.messages));
        return fauxAssistantMessage('Done.');
      },
    );
    const stream = await open('t1');
    await post('t1', { text: 'Look around', snapshot: snapshot() });
    await stream.until('turn_start');

    const res = await put('t1', snapshot({ cursorLine: 42 }));
    expect(res.status).toBe(204);
    hold.release();
    await stream.until('run_end');

    expect(requests[0]).toContain('cursor on line 3');
    expect(requests[1]).toContain('cursor on line 42');
  });

  test('invalid snapshots are rejected with 400', async () => {
    const big = 'x'.repeat(50 * 1024);
    const cases: unknown[] = [
      null,
      { ...snapshot(), cursorLine: 0 },
      { ...snapshot(), activeFile: 3 },
      { ...snapshot(), dirtyFiles: 'main.tex' },
      { ...snapshot(), revertedToolCallIds: [1] },
      { ...snapshot(), selection: { from: 5, to: 2, text: '' } },
      snapshot({
        dirtyFiles: Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.tex`, content: '' })),
      }),
      snapshot({
        dirtyFiles: Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.tex`, content: big })),
      }),
      snapshot({ dirtyFiles: [{ path: '../outside.tex', content: '' }] }),
      snapshot({ activeFile: '.latex-agent/settings.json' }),
    ];
    for (const body of cases) {
      const res = await put('t1', body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    const message = await post('t1', { text: 'hi', snapshot: { ...snapshot(), cursorLine: -1 } });
    expect(message.status).toBe(400);
  });

  test('the selection text is cut to 2000 characters', () => {
    const parsed = parseSnapshot(
      snapshot({ selection: { from: 1, to: 9, text: 'y'.repeat(MAX_SELECTION_CHARS + 500) } }),
    );
    expect(parsed.selection?.text).toHaveLength(MAX_SELECTION_CHARS);
  });
});
