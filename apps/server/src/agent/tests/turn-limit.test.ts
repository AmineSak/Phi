import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Message, ToolResultMessage } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai/providers/faux';
import { LIST_FILES } from '@phi/shared';

import { createLlm, type Llm } from '../llm.ts';
import { createThreads } from '../threads.ts';
import { MAX_TURNS, SUMMARY_REQUEST } from '../turn-limit.ts';

let root: string;
let llm: Llm;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'turn-limit-test-'));
  writeFileSync(join(root, 'main.tex'), '\\documentclass{article}\n');
  llm = createLlm({ LLM_PROVIDER: 'faux' });
});

// Every thread set a test makes, flushed before its folder goes away.
const made: ReturnType<typeof createThreads>[] = [];
const tracked = (t: ReturnType<typeof createThreads>) => (made.push(t), t);

afterEach(async () => {
  await Promise.all(made.splice(0).map((t) => t.flush()));
  rmSync(root, { recursive: true, force: true });
});

const lastUserText = (messages: (Message | AgentMessage)[]) => {
  const user = messages.findLast((m) => m.role === 'user');
  if (!user || user.role !== 'user') return '';
  return typeof user.content === 'string'
    ? user.content
    : user.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
};

/** A model that never stops calling tools, unless asked for the summary; records each request. */
function busyModel(requests: Message[][]): FauxResponseFactory {
  const respond: FauxResponseFactory = (context) => {
    requests.push(context.messages);
    llm.faux?.appendResponses([respond]);
    if (lastUserText(context.messages).endsWith(SUMMARY_REQUEST)) {
      // A tool call in the summary turn is blocked; the text still ends the run.
      return fauxAssistantMessage([
        fauxText('Summary: listed the files 29 times; the chapter is still to write.'),
        fauxToolCall(LIST_FILES, {}),
      ]);
    }
    return fauxAssistantMessage(fauxToolCall(LIST_FILES, {}));
  };
  return respond;
}

test(`a run stops after ${MAX_TURNS} turns; the last request asks for a summary`, async () => {
  const requests: Message[][] = [];
  llm.faux?.setResponses([busyModel(requests)]);
  const thread = await tracked(createThreads({ projectRoot: root, llm })).getOrCreateThread('t1');
  const ended: string[] = [];
  thread.subscribe(0, (e) => {
    if (e.type === 'run_end') ended.push(e.reason);
  });

  thread.runner.start('Write the whole thesis.', 'm1');
  await thread.runner.whenIdle();
  await Bun.sleep(0);

  expect(requests).toHaveLength(MAX_TURNS);
  // Only the last request carries the summary request.
  const asked = requests.map((r) => lastUserText(r).endsWith(SUMMARY_REQUEST));
  expect(asked.indexOf(true)).toBe(MAX_TURNS - 1);
  expect(asked.filter(Boolean)).toHaveLength(1);

  const messages = thread.agent.state.messages;
  const results = messages.filter((m): m is ToolResultMessage => m.role === 'toolResult');
  expect(results.slice(0, -1).every((r) => !r.isError)).toBe(true);
  expect(results.at(-1)).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining('turn limit') }],
  });
  const last = messages.findLast((m) => m.role === 'assistant');
  expect(JSON.stringify(last)).toContain('Summary: listed the files 29 times');
  expect(ended).toEqual(['done']);
});

test('the count starts again with each run, and short runs get no summary request', async () => {
  const requests: Message[][] = [];
  llm.faux?.setResponses([busyModel(requests)]);
  const thread = await tracked(createThreads({ projectRoot: root, llm })).getOrCreateThread('t1');
  thread.runner.start('First.', 'm1');
  await thread.runner.whenIdle();
  expect(requests).toHaveLength(MAX_TURNS);

  requests.length = 0;
  llm.faux?.setResponses([
    (context) => {
      requests.push(context.messages);
      return fauxAssistantMessage(fauxToolCall(LIST_FILES, {}));
    },
    (context) => {
      requests.push(context.messages);
      return fauxAssistantMessage('Done in two turns.');
    },
  ]);
  await Bun.sleep(0);
  thread.runner.start('Second.', 'm2');
  await thread.runner.whenIdle();
  expect(requests).toHaveLength(2);
  expect(requests.some((r) => lastUserText(r).endsWith(SUMMARY_REQUEST))).toBe(false);
});
