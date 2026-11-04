import { afterEach, beforeEach, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { LIST_FILES, PROPOSE_EDIT, type WireEvent } from '@phi/shared';

import { SAMPLE_MAIN } from '../../routes/tests/test-project.ts';
import { THREADS_DIR } from '../../services/sessions.ts';
import { createLlm, type Llm } from '../llm.ts';
import { createThreads, type Thread } from '../threads.ts';
import { INTERRUPTED, missingToolResults } from '../transcript.ts';

let root: string;
const made: ReturnType<typeof createThreads>[] = [];

/** A fresh server process: new LLM, new thread registry, same project folder. */
function boot(): { llm: Llm; threads: ReturnType<typeof createThreads> } {
  const llm = createLlm({ LLM_PROVIDER: 'faux' });
  const threads = createThreads({ projectRoot: root, llm });
  made.push(threads);
  return { llm, threads };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'persistence-test-'));
  cpSync(SAMPLE_MAIN, join(root, 'main.tex'));
});

afterEach(async () => {
  await Promise.all(made.splice(0).map((t) => t.flush().catch(() => {})));
  rmSync(root, { recursive: true, force: true });
});

const fileLines = (id: string) =>
  readFileSync(join(root, THREADS_DIR, `${id}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { type: string; message?: { role: string } });

const textOf = (m: Message | AgentMessage) =>
  'content' in m && typeof m.content !== 'string'
    ? m.content.map((c) => ('text' in c ? c.text : '')).join('')
    : 'content' in m
      ? String(m.content)
      : '';

function runEnd(thread: Thread): Promise<WireEvent> {
  return new Promise((resolve) => {
    const off = thread.subscribe(thread.lastSeq, (e) => {
      if (e.type === 'run_end') {
        off();
        resolve(e);
      }
    });
  });
}

async function run(thread: Thread, text: string) {
  const ended = runEnd(thread);
  thread.runner.start(text, crypto.randomUUID());
  return ended;
}

test('a thread survives a restart: the model sees earlier turns; the system message is not duplicated', async () => {
  let server = boot();
  server.llm.faux?.setResponses([
    fauxAssistantMessage([fauxText('Let me look.'), fauxToolCall(LIST_FILES, {})]),
    fauxAssistantMessage('Your project has main.tex.'),
  ]);
  let thread = await server.threads.getOrCreateThread('t1');
  await run(thread, 'Remember the word papaya. What files are there?');
  await server.threads.flush();

  // Stored: the header, then messages without the system prompt, usage, and the title.
  const lines = fileLines('t1');
  expect(lines.map((l) => l.type)).toContain('usage');
  expect(lines.some((l) => l.message?.role === 'system')).toBe(false);
  expect(lines.filter((l) => l.type === 'message').map((l) => l.message!.role)).toEqual([
    'user',
    'assistant',
    'toolResult',
    'assistant',
  ]);

  // Restart.
  server = boot();
  let seen: Message[] = [];
  server.llm.faux?.setResponses([
    (context) => {
      seen = context.messages;
      return fauxAssistantMessage('The word was papaya.');
    },
  ]);
  thread = await server.threads.getOrCreateThread('t1');
  expect(thread.agent.state.messages.filter((m) => m.role === 'system')).toHaveLength(1);
  expect(thread.agent.state.messages[0]?.role).toBe('system');
  await run(thread, 'Which word did I ask you to remember?');

  const roles = seen.map((m) => m.role);
  expect(roles.filter((r) => r === 'system')).toHaveLength(1);
  expect(roles.slice(1)).toEqual(['user', 'assistant', 'toolResult', 'assistant', 'user']);
  expect(textOf(seen[1]!)).toContain('papaya');
  await server.threads.flush();
  // The second run was appended, not rewritten.
  expect(fileLines('t1').filter((l) => l.type === 'message')).toHaveLength(6);
});

test('after the first run the title is the first 60 characters, published as thread_updated', async () => {
  const { llm, threads } = boot();
  llm.faux?.setResponses([fauxAssistantMessage('ok'), fauxAssistantMessage('ok again')]);
  const thread = await threads.getOrCreateThread('t1');
  const updates: WireEvent[] = [];
  thread.subscribe(0, (e) => {
    if (e.type === 'thread_updated') updates.push(e);
  });
  const long = 'Please   rewrite the introduction so that it reads more naturally and is shorter';
  await run(thread, long);
  await threads.flush();
  expect(updates).toEqual([
    expect.objectContaining({
      threadId: 't1',
      title: 'Please rewrite the introduction so that it reads more natura',
    }),
  ]);
  expect((await threads.listThreads())[0]?.title).toBe(
    'Please rewrite the introduction so that it reads more natura',
  );
  expect(fileLines('t1').filter((l) => l.type === 'title')).toHaveLength(1);
});

test('a restart during a pending review: the thread loads repaired and continues', async () => {
  let server = boot();
  server.llm.faux?.setResponses([
    fauxAssistantMessage(
      fauxToolCall(PROPOSE_EDIT, {
        path: 'main.tex',
        rationale: 'r',
        edits: [{ oldText: 'Hello from', newText: 'Welcome from' }],
      }),
    ),
  ]);
  const before = await server.threads.getOrCreateThread('t1');
  const proposed = new Promise<void>((resolve) =>
    before.subscribe(0, (e) => {
      if (e.type === 'awaiting_user') resolve();
    }),
  );
  before.runner.start('Improve the greeting', 'm1');
  await proposed;
  await new Promise((r) => setTimeout(r, 20)); // the assistant message's save
  // The server stops here: the review never gets a decision.

  server = boot();
  let seen: Message[] = [];
  server.llm.faux?.setResponses([
    (context) => {
      seen = context.messages;
      return fauxAssistantMessage('Sorry, the server restarted; shall I propose it again?');
    },
  ]);
  const thread = await server.threads.getOrCreateThread('t1');
  const stored = thread.agent.state.messages.filter((m) => m.role !== 'system');
  expect(stored.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult']);
  expect(stored[2]).toMatchObject({ toolName: PROPOSE_EDIT, isError: true });
  expect(textOf(stored[2]!)).toBe(INTERRUPTED);
  // The repair is on disk too.
  expect(fileLines('t1').filter((l) => l.type === 'message')).toHaveLength(3);

  expect(await run(thread, 'What happened?')).toMatchObject({ reason: 'done' });
  expect(seen.map((m) => m.role).slice(1)).toEqual(['user', 'assistant', 'toolResult', 'user']);
  // The history shows the interrupted proposal as a failed tool call.
  const history = thread.history();
  expect(history).toContainEqual(
    expect.objectContaining({ type: 'tool_end', isError: true, summary: INTERRUPTED }),
  );
});

test('missingToolResults answers only unanswered calls of the last assistant message', () => {
  const assistant = (ids: string[]) =>
    ({
      role: 'assistant',
      content: ids.map((id) => ({ type: 'toolCall', id, name: 'read_file', arguments: {} })),
    }) as unknown as AgentMessage;
  const result = (id: string) =>
    ({
      role: 'toolResult',
      toolCallId: id,
      toolName: 'read_file',
      content: [],
      isError: false,
      timestamp: 1,
    }) as AgentMessage;

  expect(missingToolResults([assistant(['a', 'b']), result('a')], 5)).toEqual([
    {
      role: 'toolResult',
      toolCallId: 'b',
      toolName: 'read_file',
      content: [{ type: 'text', text: INTERRUPTED }],
      isError: true,
      timestamp: 5,
    },
  ]);
  expect(missingToolResults([assistant(['a']), result('a')])).toEqual([]);
  expect(missingToolResults([{ role: 'user', content: 'hi', timestamp: 1 }])).toEqual([]);
  expect(missingToolResults([])).toEqual([]);
});

test('history: stored messages become the wire events a live run produces', async () => {
  let server = boot();
  server.llm.faux?.setResponses([
    fauxAssistantMessage([fauxText('Checking.'), fauxToolCall(LIST_FILES, {})]),
    fauxAssistantMessage('Done.'),
  ]);
  await run(await server.threads.getOrCreateThread('t1'), 'List the files');
  await server.threads.flush();

  server = boot();
  const thread = await server.threads.getOrCreateThread('t1');
  const events = thread.history();
  expect(events.map((e) => e.type)).toEqual([
    'user_message',
    'text_delta',
    'message_end',
    'tool_start',
    'tool_end',
    'text_delta',
    'message_end',
  ]);
  expect(events[0]).toMatchObject({ text: 'List the files', queued: false });
  expect(events[3]).toMatchObject({ name: LIST_FILES, label: 'List files' });
  expect(events[4]).toMatchObject({ isError: false, summary: 'main.tex (text)' });
});

test('an aborted run is saved too', async () => {
  const { llm, threads } = boot();
  llm.faux?.setResponses([
    (_context, options) =>
      new Promise((resolve) => {
        if (options?.signal?.aborted) return resolve(fauxAssistantMessage('late'));
        options?.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('late')));
      }),
  ]);
  const thread = await threads.getOrCreateThread('t1');
  const ended = runEnd(thread);
  thread.runner.start('Write a long chapter', 'm1');
  await new Promise((r) => setTimeout(r, 30));
  thread.runner.abort();
  expect(await ended).toMatchObject({ reason: 'aborted' });
  await threads.flush();
  expect(
    fileLines('t1')
      .filter((l) => l.type === 'message')
      .map((l) => l.message!.role),
  ).toEqual(['user', 'assistant']);
});
