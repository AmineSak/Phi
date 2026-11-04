// The Accept / Accept all flow of an edit proposal, clicked for real: the editor and the
// proposal bar render in a DOM (happy-dom), the server is a fake `fetch` that records every
// save and decision.
/// <reference types="bun" />
// First: the DOM must exist before React and CodeMirror load.
import { registerDom, unregisterDom } from '../../tests/dom.ts';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { applyEdits, type EditProposal } from '@phi/shared';
import { createRoot, type Root } from 'react-dom/client';

import { ProposalBar } from '../../components/Review/ProposalBar.tsx';
import { getDoc, mountEditor, closeAll } from '../../editor/views.ts';
import { useAgentStore } from '../../store/agent-store.ts';
import { useEditorStore } from '../../store/editor-store.ts';
import { dispatchReview, useReviewStore } from '../../store/review-store.ts';
import { rejectAll, startReviewPresenter } from '../reviews.ts';

const BASE = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Introduction}',
  'Hello from the sample project.',
  '',
  'The Fibonacci sequence is defined by a recurrence.',
  '\\end{document}',
  '',
].join('\n');

const EDITS = [
  { oldText: 'Hello from the sample project.', newText: 'Welcome to the sample project.' },
  {
    oldText: 'The Fibonacci sequence is defined by a recurrence.',
    newText: 'Fibonacci numbers satisfy\n$F_n = F_{n-1} + F_{n-2}$.',
  },
];

/**
 * Runs a step, then yields so React's scheduler can render. The flow under test is async
 * (loads, saves, posts); `until` waits for its results, so React's act() isn't needed.
 */
async function act(step: () => unknown): Promise<void> {
  await step();
  await new Promise((r) => setTimeout(r, 0));
}

/** The fake server: files by path, and everything the client sent. */
const server = {
  files: new Map<string, string>(),
  mtime: 1,
  saves: [] as { path: string; content: string }[],
  decisions: [] as { id: string; body: Record<string, unknown> }[],
  /** How the next decision is answered: 200, 409 (another tab was first), or 500. */
  answer: 200 as 200 | 409 | 500,
};

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'http://127.0.0.1:3000');
  const method = init?.method ?? 'GET';
  const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));
  const file = url.pathname.match(/^\/api\/files\/(.+)$/)?.[1];
  if (file) {
    const path = decodeURIComponent(file);
    if (method === 'GET') {
      const content = server.files.get(path);
      return content === undefined
        ? json({ error: 'File not found' }, 404)
        : json({ path, content, mtimeMs: server.mtime });
    }
    if (method === 'PUT') {
      const { content } = JSON.parse(String(init?.body)) as { content: string };
      server.files.set(path, content);
      server.saves.push({ path, content });
      return json({ mtimeMs: ++server.mtime });
    }
  }
  const review = url.pathname.match(/^\/api\/threads\/[^/]+\/reviews\/(.+)$/)?.[1];
  if (review && method === 'POST') {
    const id = decodeURIComponent(review);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (server.answer === 409)
      return json({ error: 'already_decided', message: 'Decided in another tab' }, 409);
    if (server.answer === 500) return json({ error: 'Server error' }, 500);
    server.decisions.push({ id, body });
    return json({ toolCallId: id, decision: body.decision });
  }
  if (url.pathname === '/api/root') return json({ root: 'main.tex', source: 'main.tex' });
  return json({ error: `unexpected ${method} ${url.pathname}` }, 404);
}

let editorHost: HTMLElement;
let barRoot: Root;
let stopPresenter: () => void;
let unmountEditor: () => void;
let nextId = 0;

/** Waits until `check` passes (the flow is async: loads, saves, posts). */
async function until(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${what}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

/** Sends a proposal as the server would (awaiting_user), and waits until it shows in the file. */
async function propose(path = 'main.tex', edits = EDITS): Promise<EditProposal> {
  const base = server.files.get(path)!;
  const { hunks, diff } = applyEdits(base, edits);
  const proposal: EditProposal = {
    id: `call-${++nextId}`,
    type: 'edit',
    path,
    rationale: 'Tighten the wording',
    hunks,
    diff,
    baseText: base,
  };
  await act(async () => {
    dispatchReview({ type: 'awaiting_user', toolCallId: proposal.id, proposal, seq: nextId });
  });
  await until(() => acceptButtons().length === hunks.length, 'the hunks to show in the file');
  return proposal;
}

const acceptButtons = () => [
  ...editorHost.querySelectorAll<HTMLButtonElement>('button[aria-label="Accept this change"]'),
];
const rejectButtons = () => [
  ...editorHost.querySelectorAll<HTMLButtonElement>('button[aria-label="Reject this change"]'),
];
const barButton = (label: string) =>
  [
    ...document.querySelectorAll<HTMLButtonElement>('section[aria-label="Proposed edit"] button'),
  ].find((b) => b.textContent?.trim() === label);
const click = (el: HTMLElement | undefined) =>
  act(async () => {
    if (!el) throw new Error('button not found');
    el.click();
  });
const editorView = () =>
  EditorView.findFromDOM(editorHost.querySelector('.cm-editor') as HTMLElement)!;
const applied = (edits = EDITS) => applyEdits(BASE, edits).newContent;

beforeAll(async () => {
  registerDom();
  globalThis.fetch = fakeFetch as typeof fetch;
  editorHost = document.createElement('div');
  const barHost = document.createElement('div');
  document.body.append(barHost, editorHost);
  unmountEditor = mountEditor(editorHost);
  barRoot = createRoot(barHost);
  await act(async () => barRoot.render(<ProposalBar />));
  stopPresenter = startReviewPresenter();
  useAgentStore.setState({ threadId: 't1' });
});

afterAll(async () => {
  stopPresenter();
  await act(async () => barRoot.unmount());
  unmountEditor();
  await unregisterDom();
});

beforeEach(() => {
  server.files = new Map([
    ['main.tex', BASE],
    ['chapters/two.tex', 'Chapter two text.\n'],
  ]);
  server.saves = [];
  server.decisions = [];
  server.answer = 200;
});

afterEach(async () => {
  await act(async () => {
    useReviewStore.setState({ queue: [], error: null, inline: null });
  });
  closeAll();
  useEditorStore.setState({ openPaths: [], activePath: null, saveStatus: {}, saveError: null });
});

describe('Accept on each change', () => {
  test('nothing is applied until every change is decided; then one save, one decision', async () => {
    const proposal = await propose();
    expect(getDoc('main.tex')).toBe(BASE); // suggestions are decorations, not text

    await click(acceptButtons()[0]);
    // The first change shows as accepted (with Undo); the file and the server are untouched.
    expect(editorHost.querySelector('.cm-proposal-accepted')?.textContent).toContain('Welcome');
    expect(getDoc('main.tex')).toBe(BASE);
    expect(server.saves).toEqual([]);
    expect(server.decisions).toEqual([]);
    expect(barButton('Accept all')).toBeDefined();

    await click(acceptButtons()[0]); // the second change's button is the only one left
    await until(() => server.decisions.length === 1, 'the decision');

    expect(getDoc('main.tex')).toBe(applied());
    expect(server.saves).toEqual([{ path: 'main.tex', content: applied() }]);
    expect(server.decisions).toEqual([
      {
        id: proposal.id,
        body: {
          decision: 'accepted',
          hunks: [
            { index: 0, accepted: true },
            { index: 1, accepted: true },
          ],
        },
      },
    ]);
    // The suggestions and the bar are gone.
    await until(
      () => !document.querySelector('section[aria-label="Proposed edit"]'),
      'the bar to go',
    );
    expect(editorHost.querySelector('.cm-proposal-suggestion, .cm-proposal-accepted')).toBeNull();

    // One undo step takes the whole proposal back (SPEC 3.5).
    undo(editorView());
    expect(getDoc('main.tex')).toBe(BASE);
  });

  test('Undo on an accepted change makes it pending again', async () => {
    await propose();
    await click(acceptButtons()[0]);
    const undoButton = editorHost.querySelector<HTMLButtonElement>(
      'button[aria-label="Undo accepting this change"]',
    );
    await click(undoButton ?? undefined);
    expect(acceptButtons()).toHaveLength(2);
    expect(server.decisions).toEqual([]);
  });

  test('accept one, reject the other: only the accepted change is applied', async () => {
    const proposal = await propose();
    await click(acceptButtons()[0]);
    await click(rejectButtons()[0]);
    await until(() => server.decisions.length === 1, 'the decision');
    expect(getDoc('main.tex')).toBe(applied([EDITS[0]!]));
    expect(server.decisions[0]).toEqual({
      id: proposal.id,
      body: {
        decision: 'accepted',
        hunks: [
          { index: 0, accepted: true },
          { index: 1, accepted: false },
        ],
      },
    });
  });

  test('edit a change, then accept: the edited text is applied and sent as finalText', async () => {
    await propose();
    const edit = editorHost.querySelector<HTMLButtonElement>(
      'button[aria-label="Edit the proposed text"]',
    );
    await click(edit ?? undefined);
    const box = editorHost.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Proposed text"]',
    )!;
    box.value = 'Greetings from the sample project.';
    await click(
      editorHost.querySelector<HTMLButtonElement>('button[aria-label="Save the edited text"]') ??
        undefined,
    );
    await click(acceptButtons()[0]);
    await click(acceptButtons()[0]);
    await until(() => server.decisions.length === 1, 'the decision');
    expect(getDoc('main.tex')).toContain('Greetings from the sample project.');
    expect(server.decisions[0]!.body.hunks).toEqual([
      { index: 0, accepted: true, finalText: 'Greetings from the sample project.' },
      { index: 1, accepted: true },
    ]);
  });
});

describe('Accept all', () => {
  test('applies every change as one undo step, saves, and posts the decision', async () => {
    const proposal = await propose();
    await click(barButton('Accept all'));
    await until(() => server.decisions.length === 1, 'the decision');
    expect(getDoc('main.tex')).toBe(applied());
    expect(server.saves).toEqual([{ path: 'main.tex', content: applied() }]);
    expect(server.decisions[0]).toEqual({
      id: proposal.id,
      body: {
        decision: 'accepted',
        hunks: [
          { index: 0, accepted: true },
          { index: 1, accepted: true },
        ],
      },
    });
    undo(editorView());
    expect(getDoc('main.tex')).toBe(BASE);
  });

  test('after one change was rejected, Accept all accepts only the rest', async () => {
    await propose();
    await click(rejectButtons()[0]);
    await click(barButton('Accept all'));
    await until(() => server.decisions.length === 1, 'the decision');
    expect(getDoc('main.tex')).toBe(applied([EDITS[1]!]));
  });

  test('a double click posts once', async () => {
    await propose();
    const button = barButton('Accept all')!;
    await act(async () => {
      button.click();
      button.click();
    });
    await until(() => server.decisions.length >= 1, 'the decision');
    await new Promise((r) => setTimeout(r, 50));
    expect(server.decisions).toHaveLength(1);
    expect(getDoc('main.tex')).toBe(applied());
  });

  test('works for a file that was not open: it opens, and the change lands there', async () => {
    await propose('chapters/two.tex', [
      { oldText: 'Chapter two text.', newText: 'Chapter two, rewritten.' },
    ]);
    expect(useEditorStore.getState().activePath).toBe('chapters/two.tex');
    await click(barButton('Accept all'));
    await until(() => server.decisions.length === 1, 'the decision');
    expect(server.files.get('chapters/two.tex')).toBe('Chapter two, rewritten.\n');
  });

  test('another tab decided first (409): the change is taken back out', async () => {
    await propose();
    server.answer = 409;
    await click(barButton('Accept all'));
    await until(() => useReviewStore.getState().queue.length === 0, 'the proposal to drop');
    expect(getDoc('main.tex')).toBe(BASE);
    expect(server.files.get('main.tex')).toBe(BASE);
  });

  test('a server error: the change is taken back out and the proposal shows again', async () => {
    await propose();
    server.answer = 500;
    await click(barButton('Accept all'));
    await until(() => !!useReviewStore.getState().error, 'the error');
    expect(getDoc('main.tex')).toBe(BASE);
    await until(() => acceptButtons().length === 2, 'the proposal to show again');
    // Retrying works once the server answers.
    server.answer = 200;
    await click(barButton('Accept all'));
    await until(() => server.decisions.length === 1, 'the decision');
    expect(getDoc('main.tex')).toBe(applied());
  });
});

describe('Reject all and stale changes', () => {
  test('Reject all: nothing changes, nothing is saved, the rejection is sent', async () => {
    const proposal = await propose();
    await click(barButton('Reject all'));
    await until(() => server.decisions.length === 1, 'the decision');
    expect(server.decisions[0]).toEqual({ id: proposal.id, body: { decision: 'rejected' } });
    expect(getDoc('main.tex')).toBe(BASE);
    expect(server.saves).toEqual([]);
    expect(editorHost.querySelector('.cm-proposal-suggestion')).toBeNull();
  });

  test('a reject reason reaches the agent', async () => {
    // What the bar calls with its reason field (typing into it is checked in the browser run).
    const proposal = await propose();
    await act(() => rejectAll(proposal.id, '  Keep my wording '));
    await until(() => server.decisions.length === 1, 'the decision');
    expect(server.decisions[0]!.body).toEqual({ decision: 'rejected', reason: 'Keep my wording' });
  });

  test('typing inside a pending change makes it stale; accepting it sends "stale", applies nothing', async () => {
    const proposal = await propose();
    const view = editorView();
    const at = BASE.indexOf('from the sample');
    await act(async () => {
      view.dispatch({ changes: { from: at, to: at + 4, insert: 'FROM' } });
    });
    expect(editorHost.textContent).toContain('You changed this text since');
    await click(barButton('Accept all'));
    await until(() => server.decisions.length === 1, 'the decision');
    expect(server.decisions[0]!.id).toBe(proposal.id);
    expect(server.decisions[0]!.body.decision).toBe('stale');
    expect(getDoc('main.tex')).toContain('Hello FROM the sample project.');
    expect(getDoc('main.tex')).not.toContain('Fibonacci numbers satisfy');
  });

  test('a review ended elsewhere (another tab, timeout, Stop) clears the suggestions', async () => {
    const proposal = await propose();
    await act(async () => {
      dispatchReview({
        type: 'review_resolved',
        toolCallId: proposal.id,
        decision: 'cancelled',
        seq: 999,
      });
    });
    await until(() => acceptButtons().length === 0, 'the suggestions to go');
    expect(getDoc('main.tex')).toBe(BASE);
  });
});
