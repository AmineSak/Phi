import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Agent, AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { COMPILE, READ_FILE } from '@phi/shared';

import { SAMPLE_MAIN } from '../../routes/tests/test-project.ts';
import { findLatexmk } from '../../services/latex.ts';
import { createLlm, type Llm } from '../llm.ts';
import { createChannel, createThreads, MAX_BUFFERED_EVENTS, type Thread } from '../threads.ts';

const hasLatexmk = findLatexmk() !== null;

let root: string;
let llm: Llm;
let threads: ReturnType<typeof createThreads>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-test-'));
  cpSync(SAMPLE_MAIN, join(root, 'main.tex'));
  llm = createLlm({ LLM_PROVIDER: 'faux' });
  threads = tracked(createThreads({ projectRoot: root, llm }));
});

// Every thread set a test makes, flushed before its folder goes away.
const made: ReturnType<typeof createThreads>[] = [];
const tracked = (t: ReturnType<typeof createThreads>) => (made.push(t), t);

afterEach(async () => {
  await Promise.all(made.splice(0).map((t) => t.flush()));
  rmSync(root, { recursive: true, force: true });
});

/** Event labels like "message_start:user"; runs of message_update collapse to one entry. */
function recordEvents(agent: Agent): string[] {
  const seen: string[] = [];
  agent.subscribe((event: AgentEvent) => {
    let label: string = event.type;
    if ('message' in event) label += `:${event.message.role}`;
    if ('toolName' in event) label += `:${event.toolName}`;
    if (label !== seen.at(-1) || event.type !== 'message_update') seen.push(label);
  });
  return seen;
}

const toolResults = (messages: AgentMessage[]) =>
  messages.filter((m): m is ToolResultMessage => m.role === 'toolResult');

const text = (message: ToolResultMessage) =>
  message.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

describe('agent runs with the faux provider', () => {
  test('compile round trip: event order and transcript', async () => {
    llm.faux?.setResponses([
      fauxAssistantMessage([fauxText('Let me compile.'), fauxToolCall(COMPILE, {})]),
      fauxAssistantMessage('The document compiles.'),
    ]);
    const { agent } = await threads.getOrCreateThread('t1');
    const events = recordEvents(agent);

    await agent.prompt('Does my document compile?');

    expect(events).toEqual([
      'agent_start',
      'turn_start',
      'message_start:user',
      'message_end:user',
      'message_start:assistant',
      'message_update:assistant',
      'message_end:assistant',
      'tool_execution_start:compile',
      'tool_execution_end:compile',
      'message_start:toolResult',
      'message_end:toolResult',
      'turn_end:assistant',
      'turn_start',
      'message_start:assistant',
      'message_update:assistant',
      'message_end:assistant',
      'turn_end:assistant',
      'agent_end',
    ]);
    expect(agent.state.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'toolResult',
      'assistant',
    ]);

    const [result] = toolResults(agent.state.messages);
    expect(result?.toolName).toBe(COMPILE);
    expect(result?.isError).toBe(!hasLatexmk);
    if (hasLatexmk) {
      expect(text(result!)).toMatch(/^Compiled main\.tex successfully in \d+\.\d s, 0 warnings\.$/);
      expect(result?.details).toMatchObject({ ok: true, errors: [] });
    }
  }, 30_000);

  test('a tool that throws produces a toolResult with isError', async () => {
    llm.faux?.setResponses([
      fauxAssistantMessage([
        fauxToolCall(READ_FILE, { path: 'chapters/missing.tex' }),
        fauxToolCall(READ_FILE, { path: '../../etc/passwd' }),
      ]),
      fauxAssistantMessage('Neither file can be read.'),
    ]);
    const { agent } = await threads.getOrCreateThread('t1');
    const ends: { toolName: string; isError: boolean }[] = [];
    agent.subscribe((e) => {
      if (e.type === 'tool_execution_end') ends.push({ toolName: e.toolName, isError: e.isError });
    });

    await agent.prompt('Read two files.');

    expect(ends).toEqual([
      { toolName: READ_FILE, isError: true },
      { toolName: READ_FILE, isError: true },
    ]);
    const [missing, traversal] = toolResults(agent.state.messages);
    expect(missing?.isError).toBe(true);
    expect(text(missing!)).toContain('File not found: chapters/missing.tex');
    expect(traversal?.isError).toBe(true);
    expect(text(traversal!)).toContain('Path must not contain ".."');
    expect(agent.state.messages.at(-1)?.role).toBe('assistant');
  });

  test("read_file's truncation hint reaches the model", async () => {
    writeFileSync(
      join(root, 'long.tex'),
      Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join('\n'),
    );
    let seenByModel = '';
    llm.faux?.setResponses([
      fauxAssistantMessage(fauxToolCall(READ_FILE, { path: 'long.tex' })),
      (context) => {
        const last = context.messages.at(-1);
        seenByModel = last?.role === 'toolResult' ? text(last) : '';
        return fauxAssistantMessage('I read the first 2000 lines.');
      },
    ]);
    const { agent } = await threads.getOrCreateThread('t1');

    await agent.prompt('Read long.tex');

    expect(seenByModel.split('\n').at(0)).toBe('line 1');
    expect(seenByModel).toEndWith(
      'line 2000\n\n[truncated: 500 more lines, continue with offset=2001]',
    );
    expect(toolResults(agent.state.messages)[0]?.details).toEqual({
      path: 'long.tex',
      totalLines: 2500,
      truncated: true,
      nextOffset: 2001,
    });
  });
});

test('unscripted faux mode answers offline by listing the files, run after run', async () => {
  const { agent } = await threads.getOrCreateThread('offline');
  for (const prompt of ['What is in here?', 'And now?']) {
    await agent.prompt(prompt);
    const last = agent.state.messages.at(-1);
    expect(last?.role).toBe('assistant');
    expect(JSON.stringify(last?.role === 'assistant' && last.content)).toContain(
      'The project contains:\\n\\n- `main.tex (text)`',
    );
  }
});

describe('threads', () => {
  test('one Agent per thread id, created once even under concurrent calls', async () => {
    const [a1, a2] = await Promise.all([
      threads.getOrCreateThread('a'),
      threads.getOrCreateThread('a'),
    ]);
    const b = await threads.getOrCreateThread('b');
    expect(a1).toBe(a2);
    expect(b.agent).not.toBe(a1.agent);
  });

  test('seq counts up per thread, independently, across runs', async () => {
    llm.faux?.setResponses([
      fauxAssistantMessage('one'),
      fauxAssistantMessage('two'),
      fauxAssistantMessage('three'),
    ]);
    const a = await threads.getOrCreateThread('a');
    const b = await threads.getOrCreateThread('b');
    const finished = (t: Thread) =>
      new Promise<void>((resolve) => {
        const off = t.subscribe(t.lastSeq, (e) => {
          if (e.type === 'run_end') {
            off();
            resolve();
          }
        });
      });

    let done = finished(a);
    a.runner.start('first', 'u1');
    await done;
    const perRun = a.lastSeq;
    done = finished(a);
    a.runner.start('second', 'u2');
    await done;
    done = finished(b);
    b.runner.start('other thread', 'u3');
    await done;

    const seqs = (t: Thread) => {
      const seen: number[] = [];
      t.subscribe(0, (e) => seen.push(e.seq))();
      return seen;
    };
    // The first run of a new thread is followed by one thread_updated (its title).
    expect(a.lastSeq).toBe(perRun * 2 + 1);
    expect(seqs(a)).toEqual(Array.from({ length: a.lastSeq }, (_, i) => i + 1));
    expect(seqs(b)).toEqual(Array.from({ length: b.lastSeq }, (_, i) => i + 1));
    expect(b.lastSeq).toBeGreaterThanOrEqual(perRun);
  });

  test('a run publishes user_message and run_start before pi events, run_end last', async () => {
    llm.faux?.setResponses([fauxAssistantMessage('Hi.')]);
    const thread = await threads.getOrCreateThread('order');
    const types: string[] = [];
    const ended = new Promise<void>((resolve) =>
      thread.subscribe(0, (e) => {
        types.push(e.type);
        if (e.type === 'run_end') resolve();
      }),
    );
    thread.runner.start('Hello', 'msg-1');
    await ended;
    expect(types.slice(0, 3)).toEqual(['user_message', 'run_start', 'turn_start']);
    expect(types.at(-1)).toBe('run_end');
  });

  test('the agent gets the system prompt, model and all tools', async () => {
    const { agent } = await threads.getOrCreateThread('a');
    expect(agent.state.systemPrompt).toContain('expert LaTeX assistant');
    expect(agent.state.model.id).toBe('faux-1');
    expect(agent.state.tools.map((t) => t.name)).toEqual([
      'list_files',
      'read_file',
      'search',
      'compile',
      'propose_edit',
      'propose_file_op',
    ]);
  });
});

describe('channel', () => {
  const turn = { type: 'turn_start' } as const;

  test('publish assigns consecutive seqs; subscribe replays after afterSeq, then goes live', () => {
    const channel = createChannel();
    channel.publish(turn);
    channel.publish(turn);
    const seen: number[] = [];
    channel.subscribe(1, (e) => seen.push(e.seq));
    expect(seen).toEqual([2]);
    channel.publish(turn);
    expect(seen).toEqual([2, 3]);
    expect(channel.lastSeq).toBe(3);
  });

  test('two subscribers receive every event in the same order', () => {
    const channel = createChannel();
    const first: string[] = [];
    const second: string[] = [];
    channel.subscribe(0, (e) => first.push(`${e.seq}:${e.type}`));
    channel.publish({ type: 'run_start', runId: 'r' });
    channel.subscribe(0, (e) => second.push(`${e.seq}:${e.type}`)); // joins late, replays
    channel.publish(turn);
    channel.publish({ type: 'run_end', reason: 'done' });
    expect(first).toEqual(['1:run_start', '2:turn_start', '3:run_end']);
    expect(second).toEqual(first);
  });

  test('unsubscribe stops delivery', () => {
    const channel = createChannel();
    const seen: number[] = [];
    const off = channel.subscribe(0, (e) => seen.push(e.seq));
    channel.publish(turn);
    off();
    channel.publish(turn);
    expect(seen).toEqual([1]);
  });

  test(`keeps only the last ${MAX_BUFFERED_EVENTS} events for replay`, () => {
    const channel = createChannel();
    for (let i = 0; i < MAX_BUFFERED_EVENTS + 5; i++) channel.publish(turn);
    const seen: number[] = [];
    channel.subscribe(0, (e) => seen.push(e.seq));
    expect(seen).toHaveLength(MAX_BUFFERED_EVENTS);
    expect(seen[0]).toBe(6);
    expect(seen.at(-1)).toBe(MAX_BUFFERED_EVENTS + 5);
  });

  test('a subscriber that throws is dropped without affecting the others', () => {
    const channel = createChannel();
    const error = console.error;
    console.error = () => {};
    try {
      const seen: number[] = [];
      channel.subscribe(0, () => {
        throw new Error('closed stream');
      });
      channel.subscribe(0, (e) => seen.push(e.seq));
      channel.publish(turn);
      channel.publish(turn);
      expect(seen).toEqual([1, 2]);
    } finally {
      console.error = error;
    }
  });
});
