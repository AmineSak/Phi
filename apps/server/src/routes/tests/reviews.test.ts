import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { JsonObject, ToolResultMessage } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import {
  applyEdits,
  PROPOSE_EDIT,
  PROPOSE_FILE_OP,
  type EditProposal,
  type ReviewToolDetails,
  type WireEvent,
} from '@phi/shared';

import { createLlm, type Llm } from '../../agent/llm.ts';
import { createThreads, type Thread } from '../../agent/threads.ts';
import { agentHandlers } from '../agent.ts';
import { guard } from '../security.ts';
import { tempProject } from './test-project.ts';

const TIMEOUT_MS = 300;

let project: ReturnType<typeof tempProject>;
let llm: Llm;
let thread: Thread;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let events: WireEvent[];

beforeEach(async () => {
  project = tempProject();
  llm = createLlm({ LLM_PROVIDER: 'faux' });
  const threads = createThreads({ projectRoot: project.root, llm, reviewTimeoutMs: TIMEOUT_MS });
  const agent = agentHandlers(threads, llm, project.root);
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = server.port ?? 0;
  base = `http://127.0.0.1:${port}/api/threads/t1`;
  server.reload({
    routes: {
      '/api/threads/:id/messages': { POST: guard(agent.messages, port) },
      '/api/threads/:id/abort': { POST: guard(agent.abort, port) },
      '/api/threads/:id/reviews/:toolCallId': { POST: guard(agent.review, port) },
    },
    fetch: () => new Response('Not found', { status: 404 }),
  });
  thread = await threads.getOrCreateThread('t1');
  events = [];
  thread.subscribe(0, (e) => events.push(e));
});

afterEach(async () => {
  await server.stop(true);
  project.remove();
});

const main = () => readFileSync(join(project.root, 'main.tex'), 'utf8');

const post = (path: string, body: unknown) =>
  fetch(`${base}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const decide = (toolCallId: string, body: unknown) =>
  post(`reviews/${encodeURIComponent(toolCallId)}`, body);

/** Waits for the next awaiting_user event and returns its proposal. */
async function awaitProposal<T = EditProposal>(): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const found = events.find(
      (e) =>
        e.type === 'awaiting_user' &&
        !events.some((r) => r.type === 'review_resolved' && r.toolCallId === e.toolCallId),
    );
    if (found?.type === 'awaiting_user') return found.proposal as T;
    await Bun.sleep(10);
  }
  throw new Error('no proposal arrived');
}

async function runEnd() {
  for (let i = 0; i < 300; i++) {
    const end = events.find((e) => e.type === 'run_end');
    if (end) return end;
    await Bun.sleep(10);
  }
  throw new Error('the run did not end');
}

/** The tool result the model received for the proposal, and its details. */
function toolResult() {
  const result = thread.agent.state.messages.find(
    (m): m is ToolResultMessage => m.role === 'toolResult',
  );
  const text = result?.content.map((c) => (c.type === 'text' ? c.text : '')).join('') ?? '';
  return {
    text,
    isError: result?.isError,
    details: result?.details as unknown as ReviewToolDetails,
  };
}

/** The web's part of an accept: apply the accepted hunks to the file and save it. */
function applyLikeTheWeb(
  proposal: EditProposal,
  accepted: { index: number; finalText?: string }[],
) {
  const edits = accepted.map(({ index, finalText }) => ({
    oldText: proposal.hunks[index]!.oldText,
    newText: finalText ?? proposal.hunks[index]!.newText,
  }));
  writeFileSync(join(project.root, 'main.tex'), applyEdits(main(), edits).newContent);
}

const TWO_HUNKS = {
  path: 'main.tex',
  rationale: 'Tighten the wording',
  edits: [
    { oldText: 'Hello from the sample project.', newText: 'Welcome to the sample project.' },
    { oldText: 'The Fibonacci sequence is defined', newText: 'Fibonacci numbers are defined' },
  ],
};

function scriptProposal(args: JsonObject = TWO_HUNKS, tool = PROPOSE_EDIT) {
  llm.faux?.setResponses([
    fauxAssistantMessage(fauxToolCall(tool, args)),
    fauxAssistantMessage('Done.'),
  ]);
}

test('accept all: the web applies, the model learns it was applied and is told to compile', async () => {
  scriptProposal();
  await post('messages', { text: 'Improve the wording' });
  const proposal = await awaitProposal();
  expect(proposal).toMatchObject({
    type: 'edit',
    path: 'main.tex',
    rationale: 'Tighten the wording',
  });
  expect(proposal.hunks).toHaveLength(2);
  expect(proposal.baseText).toBe(main());
  expect(proposal.diff).toContain('+Welcome to the sample project.');

  applyLikeTheWeb(proposal, [{ index: 0 }, { index: 1 }]);
  const res = await decide(proposal.id, {
    decision: 'accepted',
    hunks: [
      { index: 0, accepted: true },
      { index: 1, accepted: true },
    ],
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ toolCallId: proposal.id, decision: 'accepted' });

  expect(await runEnd()).toMatchObject({ reason: 'done' });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'review_resolved',
      toolCallId: proposal.id,
      decision: 'accepted',
    }),
  );
  const { text, details } = toolResult();
  expect(text).toBe(
    'The user accepted all 2 hunks; main.tex is changed and saved.\n\nCompile now to check the result.',
  );
  expect(details.outcome).toBe('accepted');
  expect(main()).toContain('Welcome to the sample project.');
});

test('partial accept with a modified hunk: the model gets the final text', async () => {
  scriptProposal();
  await post('messages', { text: 'Improve the wording' });
  const proposal = await awaitProposal();
  const finalText = 'Greetings from the sample project.';
  applyLikeTheWeb(proposal, [{ index: 0, finalText }]);
  await decide(proposal.id, {
    decision: 'accepted',
    hunks: [
      { index: 0, accepted: true, finalText },
      { index: 1, accepted: false },
    ],
  });
  await runEnd();
  const { text, details } = toolResult();
  expect(text).toContain('The user accepted hunk 1 (line 11) of 2; main.tex is changed and saved.');
  expect(text).toContain('The other hunks were rejected');
  expect(text).toContain(
    `The user edited hunk 1 (line 11) before accepting; it now reads:\n"""\n${finalText}\n"""`,
  );
  expect(details.hunks).toEqual([
    { index: 0, accepted: true, finalText },
    { index: 1, accepted: false },
  ]);
});

test('reject with a reason: nothing changes and the model gets the reason', async () => {
  const before = main();
  scriptProposal();
  await post('messages', { text: 'Improve the wording' });
  const proposal = await awaitProposal();
  await decide(proposal.id, { decision: 'rejected', reason: 'Keep my phrasing' });
  await runEnd();
  expect(toolResult().text).toBe(
    'The user rejected the proposal for main.tex; nothing was applied. Their reason: Keep my phrasing',
  );
  expect(main()).toBe(before);
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'review_resolved', decision: 'rejected' }),
  );
});

test('stale: the file changed while waiting; the model gets the current text', async () => {
  scriptProposal();
  await post('messages', { text: 'Improve the wording' });
  const proposal = await awaitProposal();
  // The user rewrote the first sentence meanwhile; the web finds hunk 0 no longer applies.
  writeFileSync(join(project.root, 'main.tex'), main().replace('Hello from', 'Hi from'));
  await decide(proposal.id, {
    decision: 'stale',
    currentRegions: [{ index: 0, text: 'Hi from the sample project.' }],
  });
  await runEnd();
  const { text, details } = toolResult();
  expect(text).toContain('Nothing was applied: main.tex changed while the proposal waited');
  expect(text).toContain(
    'Current text around hunk 1 (line 11):\n"""\nHi from the sample project.\n"""',
  );
  expect(text).toEndWith('The file changed; re-read it and propose again.');
  expect(details.outcome).toBe('stale');
});

test('two tabs decide at once: the first wins, the other gets 409', async () => {
  scriptProposal();
  await post('messages', { text: 'Improve the wording' });
  const proposal = await awaitProposal();
  const [a, b] = await Promise.all([
    decide(proposal.id, { decision: 'rejected', reason: 'tab A' }),
    decide(proposal.id, { decision: 'rejected', reason: 'tab B' }),
  ]);
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  const loser = a.status === 409 ? a : b;
  expect(await loser.json()).toMatchObject({ error: 'already_decided' });
  await runEnd();
  expect(events.filter((e) => e.type === 'review_resolved')).toHaveLength(1);
  // A decision after the end is refused too.
  expect((await decide(proposal.id, { decision: 'rejected' })).status).toBe(409);
});

test('timeout: an undecided proposal is cancelled and the model is told (SPEC 3.8)', async () => {
  scriptProposal();
  await post('messages', { text: 'Improve the wording' });
  const proposal = await awaitProposal();
  await Bun.sleep(TIMEOUT_MS + 100);
  await runEnd();
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'review_resolved',
      toolCallId: proposal.id,
      decision: 'cancelled',
    }),
  );
  expect(toolResult().text).toContain('no decision within 10 minutes');
  expect((await decide(proposal.id, { decision: 'rejected' })).status).toBe(409);
});

test('abort during review: the review ends as aborted and the run stops', async () => {
  scriptProposal();
  await post('messages', { text: 'Improve the wording' });
  const proposal = await awaitProposal();
  await post('abort', {});
  expect(await runEnd()).toMatchObject({ reason: 'aborted' });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'review_resolved',
      toolCallId: proposal.id,
      decision: 'aborted',
    }),
  );
  expect((await decide(proposal.id, { decision: 'rejected' })).status).toBe(409);
});

test('a proposal that does not match the file never reaches the user; the model gets the error', async () => {
  scriptProposal({ ...TWO_HUNKS, edits: [{ oldText: 'not in the file', newText: 'x' }] });
  await post('messages', { text: 'Improve the wording' });
  await runEnd();
  expect(events.some((e) => e.type === 'awaiting_user')).toBe(false);
  expect(toolResult()).toMatchObject({
    isError: true,
    text: expect.stringContaining('oldText was not found'),
  });
});

test('invalid decisions get 400 and leave the proposal pending', async () => {
  scriptProposal();
  await post('messages', { text: 'Improve the wording' });
  const proposal = await awaitProposal();
  for (const body of [
    { decision: 'maybe' },
    { decision: 'accepted' }, // an edit needs hunks
    { decision: 'accepted', hunks: [{ index: 5, accepted: true }] },
    { decision: 'accepted', hunks: [{ index: 0, accepted: 'yes' }] },
    { decision: 'stale', currentRegions: 'x' },
  ]) {
    expect({ body, status: (await decide(proposal.id, body)).status }).toEqual({
      body,
      status: 400,
    });
  }
  expect((await decide(proposal.id, { decision: 'rejected' })).status).toBe(200);
  await runEnd();
});

test('file ops: an accepted create is applied by the server and returns the content', async () => {
  scriptProposal(
    {
      op: 'create',
      path: 'chapters/intro.tex',
      content: '\\section{Intro}\n',
      rationale: 'Add a chapter',
    },
    PROPOSE_FILE_OP,
  );
  await post('messages', { text: 'Add an intro chapter' });
  const proposal = await awaitProposal<{ id: string; type: string }>();
  expect(proposal).toMatchObject({ type: 'file_op', op: 'create', path: 'chapters/intro.tex' });
  expect(existsSync(join(project.root, 'chapters/intro.tex'))).toBe(false);

  const res = await decide(proposal.id, { decision: 'accepted' });
  expect(await res.json()).toEqual({
    toolCallId: proposal.id,
    decision: 'accepted',
    created: { path: 'chapters/intro.tex', content: '\\section{Intro}\n' },
  });
  await runEnd();
  expect(readFileSync(join(project.root, 'chapters/intro.tex'), 'utf8')).toBe('\\section{Intro}\n');
  expect(toolResult().text).toBe('The user accepted; chapters/intro.tex was created.');
});

test('file ops: rename and delete (to the trash) on accept; a rejected op changes nothing', async () => {
  writeFileSync(join(project.root, 'notes.tex'), 'notes');
  scriptProposal(
    { op: 'rename', path: 'notes.tex', newPath: 'old-notes.tex', rationale: 'r' },
    PROPOSE_FILE_OP,
  );
  await post('messages', { text: 'Tidy up' });
  let proposal = await awaitProposal<{ id: string }>();
  await decide(proposal.id, { decision: 'accepted' });
  await runEnd();
  expect(existsSync(join(project.root, 'old-notes.tex'))).toBe(true);

  events.length = 0;
  scriptProposal({ op: 'delete', path: 'old-notes.tex', rationale: 'r' }, PROPOSE_FILE_OP);
  await post('messages', { text: 'Tidy up' });
  proposal = await awaitProposal<{ id: string }>();
  await decide(proposal.id, { decision: 'rejected' });
  await runEnd();
  expect(existsSync(join(project.root, 'old-notes.tex'))).toBe(true);

  events.length = 0;
  scriptProposal({ op: 'delete', path: 'old-notes.tex', rationale: 'r' }, PROPOSE_FILE_OP);
  await post('messages', { text: 'Tidy up' });
  proposal = await awaitProposal<{ id: string }>();
  await decide(proposal.id, { decision: 'accepted' });
  await runEnd();
  expect(existsSync(join(project.root, 'old-notes.tex'))).toBe(false);
  expect(readdirSync(join(project.root, '.latex-agent/trash'))).toHaveLength(1);
});

test('file ops that cannot apply are refused before the review', async () => {
  scriptProposal({ op: 'create', path: 'main.tex', rationale: 'r' }, PROPOSE_FILE_OP);
  await post('messages', { text: 'x' });
  await runEnd();
  expect(events.some((e) => e.type === 'awaiting_user')).toBe(false);
  expect(toolResult()).toMatchObject({
    isError: true,
    text: expect.stringContaining('already exists'),
  });
});

test('malformed edits from real models are repaired: a JSON string, or one object instead of a list', async () => {
  const edit = {
    oldText: 'Hello from the sample project.',
    newText: 'Welcome to the sample project.',
  };
  for (const edits of [JSON.stringify([edit]), edit]) {
    events.length = 0;
    scriptProposal({ path: 'main.tex', rationale: 'r', edits } as never);
    await post('messages', { text: 'Fix it' });
    const proposal = await awaitProposal();
    expect(proposal.hunks.map((h) => h.newText)).toEqual([edit.newText]);
    await decide(proposal.id, { decision: 'rejected' });
    await runEnd();
  }
});
