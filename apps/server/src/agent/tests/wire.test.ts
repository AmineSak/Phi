import { describe, expect, test } from 'bun:test';

import type { AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { Type } from 'typebox';

import { createWireContext, historyEvents, toWire, type WireContext } from '../wire.ts';

const tool: AgentTool = {
  name: 'compile',
  label: 'Compile',
  description: '',
  parameters: Type.Object({}),
  execute: async () => ({ content: [], details: undefined }),
};

const assistant = fauxAssistantMessage('Hello');
const user: AgentMessage = { role: 'user', content: 'Hi', timestamp: 0 };

/** Tool registry the context looks labels up in; tests may change it after creation. */
let registry: AgentTool[] = [tool];

function context(): WireContext {
  let n = 0;
  registry = [tool];
  return createWireContext(
    (name) => registry.find((t) => t.name === name)?.label,
    () => `m${++n}`,
  );
}

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };

const update = (assistantMessageEvent: unknown): AgentEvent =>
  ({ type: 'message_update', message: assistant, assistantMessageEvent }) as AgentEvent;

describe('toWire', () => {
  test('turn_start and turn_end pass through', () => {
    const ctx = context();
    expect(toWire({ type: 'turn_start' }, ctx)).toEqual({ type: 'turn_start' });
    expect(toWire({ type: 'turn_end', message: assistant, toolResults: [] }, ctx)).toEqual({
      type: 'turn_end',
    });
  });

  test('assistant messages get a fresh id used by their deltas and message_end', () => {
    const ctx = context();
    expect(toWire({ type: 'message_start', message: assistant }, ctx)).toBeNull();
    expect(
      toWire(
        update({ type: 'text_delta', contentIndex: 0, delta: 'Hel', partial: assistant }),
        ctx,
      ),
    ).toEqual({ type: 'text_delta', messageId: 'm1', delta: 'Hel' });
    expect(
      toWire(
        update({ type: 'thinking_delta', contentIndex: 0, delta: 'hmm', partial: assistant }),
        ctx,
      ),
    ).toEqual({ type: 'thinking_delta', messageId: 'm1', delta: 'hmm' });
    expect(toWire({ type: 'message_end', message: assistant }, ctx)).toEqual({
      type: 'message_end',
      messageId: 'm1',
      role: 'assistant',
      usage: ZERO_USAGE,
    });

    toWire({ type: 'message_start', message: assistant }, ctx);
    expect(toWire({ type: 'message_end', message: assistant }, ctx)).toMatchObject({
      messageId: 'm2',
    });
  });

  test('never forwards the partial message', () => {
    const wire = toWire(
      update({ type: 'text_delta', contentIndex: 0, delta: 'x', partial: assistant }),
      context(),
    );
    expect(JSON.stringify(wire)).not.toContain('partial');
    expect(Object.keys(wire ?? {}).sort()).toEqual(['delta', 'messageId', 'type']);
  });

  test('other message_update kinds are dropped', () => {
    const ctx = context();
    for (const type of ['start', 'text_start', 'text_end', 'toolcall_start', 'toolcall_delta']) {
      expect(toWire(update({ type, contentIndex: 0, partial: assistant }), ctx)).toBeNull();
    }
  });

  test('user and toolResult messages are dropped and do not change the message id', () => {
    const ctx = context();
    toWire({ type: 'message_start', message: assistant }, ctx);
    expect(toWire({ type: 'message_start', message: user }, ctx)).toBeNull();
    expect(toWire({ type: 'message_end', message: user }, ctx)).toBeNull();
    expect(ctx.messageId).toBe('m1');
  });

  test('tool_execution_start → tool_start with the tool label', () => {
    const ctx = context();
    expect(
      toWire(
        { type: 'tool_execution_start', toolCallId: 't1', toolName: 'compile', args: {} },
        ctx,
      ),
    ).toEqual({
      type: 'tool_start',
      toolCallId: 't1',
      name: 'compile',
      label: 'Compile',
      args: {},
    });
    expect(
      toWire(
        { type: 'tool_execution_start', toolCallId: 't2', toolName: 'made_up', args: { a: 1 } },
        ctx,
      ),
    ).toMatchObject({ name: 'made_up', label: 'made_up', args: { a: 1 } });
  });

  test('tool_execution_update → tool_update with the partial text', () => {
    expect(
      toWire(
        {
          type: 'tool_execution_update',
          toolCallId: 't1',
          toolName: 'compile',
          args: {},
          partialResult: { content: [{ type: 'text', text: 'Running latexmk…' }], details: {} },
        },
        context(),
      ),
    ).toEqual({ type: 'tool_update', toolCallId: 't1', text: 'Running latexmk…' });
  });

  test('a review_request update → awaiting_user with the proposal', () => {
    const proposal = {
      id: 't2',
      type: 'file_op' as const,
      op: 'delete' as const,
      path: 'old.tex',
      rationale: 'Unused',
    };
    expect(
      toWire(
        {
          type: 'tool_execution_update',
          toolCallId: 't2',
          toolName: 'propose_file_op',
          args: {},
          partialResult: {
            content: [{ type: 'text', text: 'Waiting for the user to review the proposal.' }],
            details: { kind: 'review_request', proposal },
          },
        },
        context(),
      ),
    ).toEqual({ type: 'awaiting_user', toolCallId: 't2', proposal });
  });

  test('tool_execution_end → tool_end with a one-line summary and details', () => {
    const details = { ok: false, errors: [] };
    expect(
      toWire(
        {
          type: 'tool_execution_end',
          toolCallId: 't1',
          toolName: 'compile',
          isError: false,
          result: {
            content: [{ type: 'text', text: '\nCompilation failed with 1 error:\nmain.tex:3: x' }],
            details,
          },
        },
        context(),
      ),
    ).toEqual({
      type: 'tool_end',
      toolCallId: 't1',
      isError: false,
      summary: 'Compilation failed with 1 error:',
      details,
    });
  });

  test('tool_end summary is capped at 200 chars and omits missing details', () => {
    const wire = toWire(
      {
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'read_file',
        isError: true,
        result: { content: [{ type: 'text', text: 'e'.repeat(500) }] },
      },
      context(),
    );
    expect(wire).toEqual({
      type: 'tool_end',
      toolCallId: 't1',
      isError: true,
      summary: `${'e'.repeat(200)}…`,
    });
  });

  test('agent_start and agent_end are not forwarded (runs emit run_start/run_end)', () => {
    const ctx = context();
    expect(toWire({ type: 'agent_start' }, ctx)).toBeNull();
    expect(toWire({ type: 'agent_end', messages: [] }, ctx)).toBeNull();
  });
});

describe('labels and usage', () => {
  test('tool labels come from the live registry, by tool name', () => {
    const ctx = context();
    registry = [...registry, { ...tool, name: 'propose_edit', label: 'Propose edit' }];
    expect(
      toWire(
        { type: 'tool_execution_start', toolCallId: 't', toolName: 'propose_edit', args: {} },
        ctx,
      ),
    ).toMatchObject({ name: 'propose_edit', label: 'Propose edit' });
  });

  test("message_end carries the message's token usage and cost in USD", () => {
    const priced = {
      ...fauxAssistantMessage('Done'),
      usage: {
        input: 1200,
        output: 340,
        cacheRead: 800,
        cacheWrite: 50,
        totalTokens: 2390,
        cost: {
          input: 0.0036,
          output: 0.0051,
          cacheRead: 0.00024,
          cacheWrite: 0.0001875,
          total: 0.0091275,
        },
      },
    };
    const ctx = context();
    toWire({ type: 'message_start', message: priced }, ctx);
    expect(toWire({ type: 'message_end', message: priced }, ctx)).toEqual({
      type: 'message_end',
      messageId: 'm1',
      role: 'assistant',
      usage: { input: 1200, output: 340, cacheRead: 800, cacheWrite: 50, costUsd: 0.0091275 },
    });
  });
});

test('history: a compaction divider sits where the compaction happened', () => {
  const user = (text: string) => ({ role: 'user' as const, content: text, timestamp: 1 });
  const events = historyEvents([user('one'), user('two'), user('three')], context(), [
    { summary: 'S1', at: 2 },
    { summary: 'S2', at: 3 },
  ]);
  expect(events.map((e) => (e.type === 'user_message' ? e.text : e.type))).toEqual([
    'one',
    'two',
    'compacted',
    'three',
    'compacted',
  ]);
  expect(events[2]).toEqual({ type: 'compacted', summary: 'S1' });
});
