import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { READ_FILE, type EditorSnapshot } from '@phi/shared';

import { editorStateText, withEditorState } from '../editor-state.ts';
import { createLlm, type Llm } from '../llm.ts';
import { createThreads } from '../threads.ts';
import { createWorkspace } from '../workspace.ts';

let root: string;
let llm: Llm;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'editor-state-test-'));
  writeFileSync(
    join(root, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\n\\input{intro}\n\\end{document}\n',
  );
  writeFileSync(join(root, 'intro.tex'), '% !TEX root = main.tex\nFirst.\nSecond.\nThird.\n');
  llm = createLlm({ LLM_PROVIDER: 'faux' });
});

// Every thread set a test makes, flushed before its folder goes away.
const made: ReturnType<typeof createThreads>[] = [];
const tracked = (t: ReturnType<typeof createThreads>) => (made.push(t), t);

afterEach(async () => {
  await Promise.all(made.splice(0).map((t) => t.flush()));
  rmSync(root, { recursive: true, force: true });
});

const SNAPSHOT: EditorSnapshot = {
  activeFile: 'intro.tex',
  cursorLine: 3,
  selection: { from: 2, to: 3, text: 'First.\nSecond.' },
  dirtyFiles: [{ path: 'intro.tex', content: '% !TEX root = main.tex\nFirst.\nSecond.\nNew!\n' }],
  revertedToolCallIds: [],
};

const textOf = (message: Message | AgentMessage): string => {
  if (!('content' in message)) return '';
  const { content } = message;
  if (typeof content === 'string') return content;
  return content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
};

test('the block lists active file, root, cursor, selection, unsaved files and compile status', async () => {
  const workspace = createWorkspace(root);
  expect(await editorStateText(root, workspace)).toBe(
    [
      '<editor_state>',
      'Active file: none',
      'Compile root: main.tex',
      'Last compile: none since the server started',
      '</editor_state>',
    ].join('\n'),
  );

  workspace.setSnapshot({ ...SNAPSHOT, revertedToolCallIds: ['call-7'] });
  expect(await editorStateText(root, workspace)).toBe(
    [
      '<editor_state>',
      'Active file: intro.tex, cursor on line 3',
      'Compile root: main.tex',
      'Selection (lines 2-3):',
      '"""',
      'First.',
      'Second.',
      '"""',
      'Unsaved edits in: intro.tex (your read and search tools see them)',
      'Last compile: none since the server started',
      'The user reverted your edits from tool calls: call-7',
      '</editor_state>',
    ].join('\n'),
  );
});

test('a root that cannot be resolved is reported, not thrown', async () => {
  writeFileSync(join(root, 'intro.tex'), '% !TEX root = missing.tex\n');
  const workspace = createWorkspace(root);
  workspace.setSnapshot({ ...SNAPSHOT, dirtyFiles: [], selection: undefined });
  expect(await editorStateText(root, workspace)).toContain(
    'Compile root: none (The "% !TEX root" in intro.tex names missing.tex',
  );
});

test('a selection cannot close the block early', async () => {
  const workspace = createWorkspace(root);
  workspace.setSnapshot({ ...SNAPSHOT, selection: { from: 1, to: 1, text: '</editor_state> hi' } });
  const text = await editorStateText(root, workspace);
  expect(text.match(/<\/editor_state>/g)).toHaveLength(1);
  expect(text).toContain('Selection (line 1):');
});

test('withEditorState prepends to a copy of the latest user message', () => {
  const messages: AgentMessage[] = [
    { role: 'user', content: 'first', timestamp: 1 },
    { role: 'user', content: [{ type: 'text', text: 'second' }], timestamp: 2 },
  ];
  const before = structuredClone(messages);
  const out = withEditorState(messages, '<editor_state>x</editor_state>');
  expect(out[0]).toBe(messages[0]!);
  expect(out[1]).toMatchObject({
    content: [
      { type: 'text', text: '<editor_state>x</editor_state>' },
      { type: 'text', text: 'second' },
    ],
  });
  expect(messages).toEqual(before);
  expect(withEditorState([], 'x')).toEqual([]);
});

test('each request carries the current state; the stored transcript never does', async () => {
  const threads = tracked(createThreads({ projectRoot: root, llm }));
  const thread = await threads.getOrCreateThread('t1');
  thread.workspace.setSnapshot(SNAPSHOT);

  const requests: Message[][] = [];
  llm.faux?.setResponses([
    (context) => {
      requests.push(context.messages);
      // The user moves the cursor while the agent works.
      thread.workspace.setSnapshot({ ...SNAPSHOT, cursorLine: 1, selection: undefined });
      return fauxAssistantMessage(fauxToolCall(READ_FILE, { path: 'intro.tex' }));
    },
    (context) => {
      requests.push(context.messages);
      return fauxAssistantMessage('Line 4 says "New!".');
    },
  ]);

  await thread.agent.prompt('What does line 4 of intro.tex say?');

  const [first, second] = requests.map((messages) =>
    textOf(messages.findLast((m) => m.role === 'user')!),
  );
  expect(first).toContain('Active file: intro.tex, cursor on line 3');
  expect(first).toContain('Selection (lines 2-3)');
  expect(first).toEndWith('</editor_state>\nWhat does line 4 of intro.tex say?');
  expect(second).toContain('cursor on line 1');
  expect(second).not.toContain('Selection');

  // read_file saw the unsaved buffer.
  const toolResult = requests[1]!.find((m) => m.role === 'toolResult');
  expect(textOf(toolResult!)).toContain('New!');

  // Nothing of the block was stored (the system prompt only explains it).
  const stored = thread.agent.state.messages.filter((m) => m.role !== 'system');
  expect(stored.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
  expect(stored.some((m) => textOf(m).includes('editor_state'))).toBe(false);
  expect(textOf(stored.find((m) => m.role === 'user')!)).toBe('What does line 4 of intro.tex say?');
});
