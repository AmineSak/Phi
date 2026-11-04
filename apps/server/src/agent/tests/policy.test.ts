import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolResultMessage } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { PROPOSE_EDIT, PROPOSE_FILE_OP, READ_FILE } from '@phi/shared';

import { createLlm } from '../llm.ts';
import { changeOf, preambleBlockReason, type ProposedChange } from '../policy.ts';
import { decideReview } from '../reviews.ts';
import { createThreads } from '../threads.ts';
import { createWorkspace, type Workspace } from '../workspace.ts';

const MAIN = [
  '\\documentclass{article}',
  '\\usepackage{graphicx}',
  '\\title{Thesis}',
  '\\begin{document}',
  '\\maketitle',
  'Body text.',
  '\\end{document}',
  '',
].join('\n');

let root: string;
let workspace: Workspace;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'policy-test-'));
  writeFileSync(join(root, 'main.tex'), MAIN);
  writeFileSync(join(root, 'intro.tex'), '\\section{Intro}\n\\usepackage{fake}\n');
  writeFileSync(join(root, 'macros.sty'), '\\newcommand{\\R}{\\mathbb{R}}\n');
  workspace = createWorkspace(root);
});

// Every thread set a test makes, flushed before its folder goes away.
const made: ReturnType<typeof createThreads>[] = [];
const tracked = (t: ReturnType<typeof createThreads>) => (made.push(t), t);

afterEach(async () => {
  await Promise.all(made.splice(0).map((t) => t.flush()));
  rmSync(root, { recursive: true, force: true });
});

const edit = (path: string, oldText: string, newText: string): ProposedChange => ({
  kind: 'edit',
  path,
  edits: [{ oldText, newText }],
});

const blocked = (change: ProposedChange, message: string) =>
  preambleBlockReason(change, message, workspace);

describe('changeOf reads the change from propose_edit and propose_file_op calls', () => {
  test('edit, create, rename and delete; other tools and bad shapes are not changes', () => {
    const edits = [{ oldText: 'a', newText: 'b' }];
    expect(changeOf(PROPOSE_EDIT, { path: 'main.tex', edits, rationale: 'x' })).toEqual({
      kind: 'edit',
      path: 'main.tex',
      edits,
    });
    const op = (args: Record<string, unknown>) =>
      changeOf(PROPOSE_FILE_OP, { rationale: 'x', ...args });
    expect(op({ op: 'create', path: 'a.tex', content: 'hi' })).toEqual({
      kind: 'create',
      path: 'a.tex',
      content: 'hi',
    });
    expect(op({ op: 'create', path: 'a.tex' })).toEqual({
      kind: 'create',
      path: 'a.tex',
      content: '',
    });
    expect(op({ op: 'rename', path: 'a.sty', newPath: 'b.sty' })).toEqual({
      kind: 'rename',
      path: 'a.sty',
      to: 'b.sty',
    });
    expect(op({ op: 'delete', path: 'a.tex' })).toEqual({ kind: 'delete', path: 'a.tex' });
    expect(op({ op: 'rename', path: 'a.tex' })).toBeNull();
    expect(changeOf(READ_FILE, { path: 'main.tex' })).toBeNull();
    expect(changeOf(PROPOSE_EDIT, { path: 'main.tex', edits: [{ oldText: 1 }] })).toBeNull();
    expect(changeOf(PROPOSE_EDIT, null)).toBeNull();
  });
});

describe('preamble of a root file (SPEC 1.3)', () => {
  test('an edit before \\begin{document} is blocked; the reason says to ask the user', async () => {
    const reason = await blocked(
      edit('main.tex', '\\usepackage{graphicx}', '\\usepackage{graphicx}\n\\usepackage{xcolor}'),
      'Make the title red.',
    );
    expect(reason).toContain('the preamble of main.tex');
    expect(reason).toContain('Ask the user');
  });

  test('\\documentclass and \\begin{document} itself are part of it', async () => {
    expect(await blocked(edit('main.tex', 'article', 'report'), 'Fix the body')).not.toBeNull();
    expect(
      await blocked(edit('main.tex', '\\begin{document}\n\\maketitle', '\\begin{document}'), 'x'),
    ).not.toBeNull();
  });

  test('edits in the body are allowed', async () => {
    expect(await blocked(edit('main.tex', 'Body text.', 'Better body.'), 'Rephrase it')).toBeNull();
  });

  test('allowed when the message mentions the preamble, the package or the file', async () => {
    const change = edit('main.tex', '\\title{Thesis}', '\\title{Thesis}\n\\usepackage{xcolor}');
    expect(await blocked(change, 'Add xcolor to the PREAMBLE please')).toBeNull();
    expect(await blocked(change, 'I need the xcolor package')).toBeNull();
    expect(await blocked(change, 'Fix the error in main.tex')).toBeNull();
    // Mentions must be whole words: "preambles" is fine, "xcolors" or "domain.tex" are not.
    expect(await blocked(change, 'xcolors everywhere, see domain.tex')).not.toBeNull();
  });

  test('the unsaved editor buffer decides where the preamble ends', async () => {
    // On disk, "Body text." is in the body; in the editor, the user moved it above \begin{document}.
    workspace.setSnapshot({
      activeFile: 'main.tex',
      cursorLine: 1,
      dirtyFiles: [
        { path: 'main.tex', content: '\\documentclass{article}\nBody text.\n\\begin{document}\n' },
      ],
      revertedToolCallIds: [],
    });
    expect(await blocked(edit('main.tex', 'Body text.', 'x'), 'Rephrase it')).not.toBeNull();
  });

  test('files without \\documentclass have no preamble', async () => {
    expect(await blocked(edit('intro.tex', '\\usepackage{fake}', ''), 'Tidy up')).toBeNull();
    expect(await blocked(edit('missing.tex', 'a', 'b'), 'Tidy up')).toBeNull();
  });

  test('deleting a root document is blocked; creating one is not', async () => {
    expect(await blocked({ kind: 'delete', path: 'main.tex' }, 'Clean up')).toContain(
      'main.tex, a root document',
    );
    expect(await blocked({ kind: 'delete', path: 'intro.tex' }, 'Clean up')).toBeNull();
    expect(
      await blocked({ kind: 'create', path: 'new.tex', content: '\\documentclass{article}' }, 'x'),
    ).toBeNull();
  });
});

describe('.cls and .sty files (SPEC 1.3)', () => {
  test('any change is blocked unless the message names the file or package', async () => {
    const change = edit('macros.sty', '\\R', '\\Reals');
    expect(await blocked(change, 'Rename the reals macro')).toContain('macros.sty, a package file');
    expect(await blocked(change, 'Rename the reals macro in macros.sty')).toBeNull();
    expect(await blocked(change, 'Update the macros package')).toBeNull();
  });

  test('creating, renaming to or deleting a .cls or .sty is covered too', async () => {
    expect(
      await blocked({ kind: 'create', path: 'thesis.cls', content: '' }, 'Set up a class'),
    ).toContain('thesis.cls, a class file');
    expect(await blocked({ kind: 'rename', path: 'a.tex', to: 'a.sty' }, 'x')).not.toBeNull();
    expect(await blocked({ kind: 'delete', path: 'macros.sty' }, 'Delete macros.sty')).toBeNull();
  });
});

test('real propose_edit and propose_file_op calls are blocked before any review', async () => {
  const llm = createLlm({ LLM_PROVIDER: 'faux' });
  const thread = await tracked(createThreads({ projectRoot: root, llm })).getOrCreateThread('t1');
  const reviewed: string[] = [];
  // The allowed proposal reaches the review queue; reject it so the run can finish.
  thread.subscribe(0, (event) => {
    if (event.type !== 'awaiting_user') return;
    reviewed.push(
      event.proposal.type === 'edit' ? event.proposal.hunks[0]!.oldText : event.proposal.path,
    );
    void decideReview(root, thread.pending, event.toolCallId, {
      decision: 'rejected',
      reason: 'test',
    });
  });
  const edit = (oldText: string, newText: string) =>
    fauxToolCall(PROPOSE_EDIT, { path: 'main.tex', edits: [{ oldText, newText }], rationale: 'r' });
  llm.faux?.setResponses([
    fauxAssistantMessage(edit('\\title{Thesis}', '\\title{Thesis}\n\\usepackage{hyperref}')),
    fauxAssistantMessage(
      fauxToolCall(PROPOSE_FILE_OP, { op: 'delete', path: 'main.tex', rationale: 'r' }),
    ),
    fauxAssistantMessage(edit('Body text.', 'Better text.')),
    fauxAssistantMessage('Done.'),
  ]);

  await thread.agent.prompt('Improve the wording of the body.');

  const results = thread.agent.state.messages.filter(
    (m): m is ToolResultMessage => m.role === 'toolResult',
  );
  expect(results.map((r) => r.isError)).toEqual([true, true, false]);
  expect(results[0]!.content).toMatchObject([
    { text: expect.stringContaining('the preamble of main.tex') },
  ]);
  expect(results[1]!.content).toMatchObject([
    { text: expect.stringContaining('main.tex, a root document') },
  ]);
  expect(results[2]!.content).toMatchObject([{ text: expect.stringContaining('rejected') }]);
  expect(reviewed).toEqual(['Body text.']);
});
