import { expect, test } from 'bun:test';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate';

import {
  contextEstimate,
  cutIndex,
  estimateTokens,
  isSummary,
  needsCompaction,
  RESERVE_TOKENS,
  summaryMessage,
  transcriptText,
} from '../compaction.ts';

// Text that pi's estimator counts as about n tokens.
const CHARS_PER_TOKEN = 40_000 / estimateTextTokens('x'.repeat(40_000));
const tokens = (n: number) => 'x'.repeat(Math.round(n * CHARS_PER_TOKEN));
const user = (text: string): AgentMessage => ({ role: 'user', content: text, timestamp: 1 });
const usage = (input: number, output = 0) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const assistant = (
  content: unknown[] = [{ type: 'text', text: 'ok' }],
  over: Record<string, unknown> = {},
): AgentMessage =>
  ({
    role: 'assistant',
    content,
    api: 'faux',
    provider: 'faux',
    model: 'm',
    usage: usage(0),
    stopReason: 'stop',
    timestamp: 1,
    ...over,
  }) as AgentMessage;
const toolCall = (id: string) =>
  assistant([{ type: 'toolCall', id, name: 'read_file', arguments: {} }], {
    stopReason: 'toolUse',
  });
const toolResult = (id: string, text = 'result'): AgentMessage =>
  ({
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read_file',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 1,
  }) as AgentMessage;

test('estimate: last answered usage, plus what came after, plus the new message', () => {
  const messages = [
    user(tokens(1000)),
    assistant([{ type: 'text', text: 'ok' }], { usage: usage(5000, 200) }),
    user(tokens(300)),
    // A failed request's usage says nothing about the context.
    assistant([], { stopReason: 'error', usage: usage(99_999) }),
  ];
  const estimate = contextEstimate(messages, tokens(100));
  expect(estimate).toBeGreaterThanOrEqual(5200 + 300 + 100);
  expect(estimate).toBeLessThan(5200 + 300 + 100 + 100);
  // No answered request yet: estimate every message.
  expect(contextEstimate([user(tokens(1000))])).toBeGreaterThanOrEqual(1000);
});

test('compact above the context window minus 16k', () => {
  expect(RESERVE_TOKENS).toBe(16_000);
  expect(needsCompaction(111_999, 128_000)).toBe(false);
  expect(needsCompaction(112_001, 128_000)).toBe(true);
  expect(needsCompaction(10, 0)).toBe(false); // unknown window: never
});

test('cut: keeps about 20k recent tokens', () => {
  const messages = [
    user(tokens(9000)),
    assistant(),
    user(tokens(9000)),
    assistant(),
    user(tokens(9000)),
    assistant(),
    user(tokens(9000)),
    assistant(),
  ];
  // From the end: 9k, 18k, then 27k at the second user message, past 20k: the cut is there.
  expect(cutIndex(messages)).toBe(2);
});

test('cut: never splits a tool call from its results', () => {
  const messages = [
    user(tokens(9000)),
    assistant(),
    user('Read both files'),
    assistant(
      [
        { type: 'toolCall', id: 'a', name: 'read_file', arguments: {} },
        { type: 'toolCall', id: 'b', name: 'read_file', arguments: {} },
      ],
      { stopReason: 'toolUse' },
    ),
    toolResult('a', tokens(6000)),
    toolResult('b', tokens(15000)),
    assistant(),
  ];
  // 20k is reached inside the results; the cut moves back to the call that made them.
  const cut = cutIndex(messages)!;
  expect(messages[cut]?.role).toBe('assistant');
  expect(cut).toBe(3);
  for (let i = cut; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'toolResult') {
      const calls = messages
        .slice(cut, i)
        .flatMap((x) =>
          x.role === 'assistant'
            ? x.content.flatMap((c) => (c.type === 'toolCall' ? [c.id] : []))
            : [],
        );
      expect(calls).toContain(m.toolCallId);
    }
  }
});

test('cut: nothing to summarize when everything fits, or only an earlier summary is older', () => {
  expect(cutIndex([user('hi'), assistant()])).toBeNull();
  expect(cutIndex([summaryMessage('Earlier.'), user(tokens(25_000)), assistant()])).toBeNull();
  expect(cutIndex([toolCall('a'), toolResult('a', tokens(25_000))])).toBeNull();
});

test('summary message and transcript text', () => {
  const message = summaryMessage('## Goal\nFinish chapter 2.');
  expect(isSummary(message)).toBe(true);
  expect(isSummary(user('hello'))).toBe(false);
  expect(estimateTokens(message)).toBeGreaterThan(5);

  const text = transcriptText([
    message,
    user('Fix the intro'),
    toolCall('a'),
    toolResult('a', 'line one'),
    assistant([], { stopReason: 'error' }),
    assistant([{ type: 'text', text: 'Done.' }]),
  ]);
  expect(text).toContain('EARLIER SUMMARY:\n<conversation_summary>');
  expect(text).toContain('USER:\nFix the intro');
  expect(text).toContain('ASSISTANT called read_file: {}');
  expect(text).toContain('TOOL read_file:\nline one');
  expect(text).toContain('ASSISTANT:\nDone.');
});
