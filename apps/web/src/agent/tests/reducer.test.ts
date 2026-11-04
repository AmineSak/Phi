/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import type { WireEvent } from '@phi/shared';

import {
  addUsage,
  endRunLocally,
  fromHistory,
  initialChatState,
  reduce,
  removeMessage,
  upsertUserMessage,
  ZERO_USAGE,
  type AssistantMessage,
  type ChatState,
  type UserMessage,
} from '../reducer.ts';

// Real thread streams recorded from the server with the faux model:
// bun apps/server/scripts/record-chat-fixtures.ts
type ClientLine =
  | { client: 'send'; text: string; messageId: string }
  | { client: 'response'; messageId: string; status: number; body: Record<string, unknown> }
  | { client: 'abort' }
  | { client: 'reload'; lastEventId: number };
type Line = WireEvent | ClientLine;

const FIXTURES = ['tool-run', 'tool-error', 'aborted', 'steered', 'model-error', 'reconnect'];

async function lines(name: string): Promise<Line[]> {
  const text = await Bun.file(join(import.meta.dir, '__fixtures__', `${name}.jsonl`)).text();
  return text
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Line);
}

const isEvent = (l: Line): l is WireEvent => 'type' in l;
const events = (fixture: Line[]) => fixture.filter(isEvent);

/** The sending tab: optimistic user messages, settled by the POST response, plus the stream. */
function sendingTab(fixture: Line[]): ChatState {
  return fixture.reduce<ChatState>((state, line) => {
    if (isEvent(line)) return reduce(state, line);
    if (line.client === 'send') {
      return upsertUserMessage(state, line.messageId, line.text, state.runStatus === 'running');
    }
    if (line.client === 'response') {
      if (line.status !== 202) return removeMessage(state, line.messageId);
      const sent = state.messages.find((m) => m.id === line.messageId);
      return sent?.role === 'user'
        ? upsertUserMessage(state, line.messageId, sent.text, line.body.queued === true)
        : state;
    }
    return state; // abort and reload change nothing locally; the stream reports the outcome
  }, initialChatState);
}

/** Any other tab, or the same tab after a page reload: only what the stream delivers. */
const streamOnly = (fixture: Line[]) => events(fixture).reduce(reduce, initialChatState);

const assistants = (s: ChatState) =>
  s.messages.filter((m): m is AssistantMessage => m.role === 'assistant');
const texts = (s: ChatState) =>
  assistants(s)
    .map((m) => m.text)
    .filter(Boolean);
const users = (s: ChatState) => s.messages.filter((m): m is UserMessage => m.role === 'user');

describe('fixtures', () => {
  test('tool-run: thinking, a tool call, then the answer, with usage', async () => {
    const fixture = await lines('tool-run');
    const state = sendingTab(fixture);
    expect(state.runStatus).toBe('done');
    expect(state.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(users(state)).toEqual([
      { role: 'user', id: 'u1', text: 'What is in this project?', queued: false },
    ]);

    const [first, answer] = assistants(state);
    expect(first).toMatchObject({
      thinking: 'I should look at the project files first.',
      text: 'Let me check the project.',
      streaming: false,
    });
    expect(answer?.text).toContain('```latex\n\\documentclass{article}');

    const ends = events(fixture).filter((e) => e.type === 'message_end');
    expect(first?.usage).toEqual(ends[0]?.usage);
    expect(answer?.usage).toEqual(ends[1]?.usage);
    expect(state.totals).toEqual(ends.map((e) => e.usage).reduce(addUsage, ZERO_USAGE));
    expect(state.totals.input).toBeGreaterThan(0);

    const tool = Object.values(state.tools)[0];
    expect(tool).toMatchObject({ name: 'list_files', label: 'List files', status: 'done' });
    expect(tool?.summary).toBe('main.tex');
  });

  test('tool-error: the failed tool is marked error with its message', async () => {
    const state = sendingTab(await lines('tool-error'));
    expect(Object.values(state.tools)[0]).toMatchObject({
      name: 'read_file',
      status: 'error',
      summary: 'File not found: chapters/missing.tex',
    });
    expect(texts(state)).toEqual(['That file does not exist.']);
  });

  test('aborted: run ends aborted, nothing left streaming or running', async () => {
    const state = sendingTab(await lines('aborted'));
    expect(state.runStatus).toBe('aborted');
    expect(assistants(state).every((m) => !m.streaming)).toBe(true);
    expect(Object.values(state.tools).every((t) => t.status !== 'running')).toBe(true);
    expect(texts(state)).toEqual(['Listing files first.']);
  });

  test('steered: queued from the POST until the next turn_start, never duplicated', async () => {
    const fixture = await lines('steered');
    const queuedAt = fixture.findIndex((l) => isEvent(l) && l.type === 'user_message' && l.queued);
    const pickup = fixture.findIndex(
      (l, i) => i > queuedAt && isEvent(l) && l.type === 'turn_start',
    );

    const waiting = sendingTab(fixture.slice(0, pickup));
    expect(users(waiting).map((m) => [m.id, m.queued])).toEqual([
      ['u1', false],
      ['u2', true],
    ]);

    const state = sendingTab(fixture);
    expect(users(state).map((m) => [m.id, m.queued])).toEqual([
      ['u1', false],
      ['u2', false],
    ]);
    expect(texts(state)).toEqual([
      'Here is the introduction fix.',
      'And the bibliography looks fine.',
    ]);
  });

  test('model-error: the run ends with the provider message', async () => {
    expect(sendingTab(await lines('model-error'))).toMatchObject({
      runStatus: 'error',
      runError: 'Rate limited by provider',
    });
  });

  test('reconnect: the resumed stream continues with nothing lost or repeated', async () => {
    const state = sendingTab(await lines('reconnect'));
    expect(texts(state)).toEqual(['Still here after the reload.']);
    expect(state.runStatus).toBe('done');
  });
});

describe('multiple tabs and reloads', () => {
  test('a second tab renders exactly what the sending tab renders', async () => {
    for (const name of FIXTURES) {
      const fixture = await lines(name);
      expect({ name, state: streamOnly(fixture) }).toEqual({ name, state: sendingTab(fixture) });
    }
  });

  test('replaying the whole buffer again (reconnect from 0) changes nothing', async () => {
    for (const name of FIXTURES) {
      const fixture = await lines(name);
      const once = sendingTab(fixture);
      expect({ name, state: events(fixture).reduce(reduce, once) }).toEqual({ name, state: once });
    }
  });

  test('an overlapping resume equals a clean stream: no duplicated text', async () => {
    const all = events(await lines('tool-run'));
    const overlapping = [...all.slice(0, 12), ...all.slice(5)];
    expect(overlapping.reduce(reduce, initialChatState)).toEqual(
      all.reduce(reduce, initialChatState),
    );
  });

  test('events at or below lastSeq are ignored', () => {
    const state = { ...initialChatState, lastSeq: 5 };
    expect(reduce(state, { type: 'run_end', reason: 'error', error: 'old', seq: 5 })).toBe(state);
  });
});

describe('local messages', () => {
  test('a refused message is removed', () => {
    const state = upsertUserMessage(initialChatState, 'u1', 'hi', false);
    expect(removeMessage(state, 'u1').messages).toEqual([]);
  });

  test("the server's user_message merges into the sender's optimistic copy", () => {
    let state = upsertUserMessage(initialChatState, 'u1', 'hi', true);
    state = reduce(state, {
      type: 'user_message',
      messageId: 'u1',
      text: 'hi',
      queued: false,
      seq: 1,
    });
    expect(users(state)).toEqual([{ role: 'user', id: 'u1', text: 'hi', queued: false }]);
  });

  test('tool_update shows progress until tool_end', () => {
    let state = reduce(initialChatState, {
      type: 'tool_start',
      toolCallId: 't',
      name: 'compile',
      label: 'Compile',
      args: {},
      seq: 1,
    });
    state = reduce(state, { type: 'tool_update', toolCallId: 't', text: 'Running…', seq: 2 });
    expect(state.tools.t?.progress).toBe('Running…');
    state = reduce(state, {
      type: 'tool_end',
      toolCallId: 't',
      isError: false,
      summary: 'ok',
      seq: 3,
    });
    expect(state.tools.t).toMatchObject({ status: 'done', summary: 'ok', progress: undefined });
  });
});

test('fromHistory rebuilds messages, tool cards and usage totals; the live stream follows', () => {
  const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 };
  const state = fromHistory([
    { type: 'user_message', messageId: 'u1', text: 'Fix it', queued: false },
    { type: 'text_delta', messageId: 'a1', delta: 'Proposing a fix.' },
    { type: 'message_end', messageId: 'a1', role: 'assistant', usage },
    { type: 'tool_start', toolCallId: 'c1', name: 'propose_edit', label: 'Propose edit', args: {} },
    {
      type: 'tool_end',
      toolCallId: 'c1',
      isError: true,
      summary: 'Interrupted: the server restarted before this finished.',
    },
    { type: 'text_delta', messageId: 'a2', delta: 'Done.' },
    { type: 'message_end', messageId: 'a2', role: 'assistant', usage },
  ]);
  expect(state.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  expect(state.messages.every((m) => m.role !== 'assistant' || !m.streaming)).toBe(true);
  expect(state.tools.c1).toMatchObject({ status: 'error' });
  expect(state.totals).toEqual({ ...usage, input: 200, output: 40, costUsd: 0.02 });
  expect(state.lastSeq).toBe(0);
  expect(state.runStatus).toBe('idle');

  // Live events from seq 1 apply on top.
  const live = reduce(state, {
    type: 'user_message',
    messageId: 'u2',
    text: 'More',
    queued: false,
    seq: 1,
  });
  expect(live.messages.at(-1)).toMatchObject({ role: 'user', text: 'More' });
});

describe('reliability events (SPEC 8)', () => {
  const start = reduce(initialChatState, { type: 'run_start', runId: 'r', seq: 1 });

  test('status shows until the agent moves on', () => {
    let state = reduce(start, { type: 'status', message: 'Retrying (1/3)…', seq: 2 });
    expect(state.status).toBe('Retrying (1/3)…');
    state = reduce(state, { type: 'status', message: 'Retrying (2/3)…', seq: 3 });
    expect(state.status).toBe('Retrying (2/3)…');
    state = reduce(state, { type: 'text_delta', messageId: 'a', delta: 'Hi', seq: 4 });
    expect(state.status).toBeUndefined();
  });

  test('compacted adds a divider in place', () => {
    let state = reduce(start, {
      type: 'user_message',
      messageId: 'u',
      text: 'hi',
      queued: false,
      seq: 2,
    });
    state = reduce(state, { type: 'compacted', summary: '## Goal\nX', seq: 3 });
    expect(state.messages.map((m) => m.role)).toEqual(['user', 'compaction']);
    expect(state.messages[1]).toMatchObject({ summary: '## Goal\nX' });
    // History can hold several; their ids differ.
    const twice = fromHistory([
      { type: 'compacted', summary: 'A' },
      { type: 'user_message', messageId: 'u', text: 'x', queued: false },
      { type: 'compacted', summary: 'B' },
    ]);
    expect(new Set(twice.messages.map((m) => m.id)).size).toBe(3);
  });

  test('endRunLocally ends a running run with the error, once', () => {
    const ended = endRunLocally(start, 'lost');
    expect(ended).toMatchObject({ runStatus: 'error', runError: 'lost' });
    expect(endRunLocally(ended, 'again')).toBe(ended);
    expect(endRunLocally(initialChatState, 'x')).toBe(initialChatState);
  });
});
