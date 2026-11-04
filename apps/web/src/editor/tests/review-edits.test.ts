import { describe, expect, test } from 'bun:test';

import { applyEdits, type EditProposal } from '@phi/shared';

import {
  acceptedEdits,
  canRevert,
  finishPlan,
  locateHunks,
  regionAround,
  revertEdits,
} from '../review-edits.ts';
import type { InlineProposal } from '../proposal.ts';

const BASE = [
  '\\section{Intro}',
  'First sentence here.',
  '\\begin{itemize}',
  '  \\item',
  '  \\item',
  '\\end{itemize}',
  'Last sentence here.',
  '',
].join('\n');

function proposal(edits: { oldText: string; newText: string }[]): EditProposal {
  const { hunks, diff } = applyEdits(BASE, edits);
  return { id: 'call-1', type: 'edit', path: 'a.tex', rationale: 'r', hunks, diff, baseText: BASE };
}

const P = proposal([
  { oldText: 'First sentence', newText: 'Opening sentence' },
  { oldText: 'Last sentence', newText: 'Closing sentence' },
]);

test('locateHunks finds each hunk in the buffer as it is now', () => {
  // The user typed above the hunks since the proposal was made: positions move.
  const current = `% a note\n${BASE}`;
  const inline = locateHunks(current, P);
  expect(inline.id).toBe('call-1');
  for (const h of inline.hunks) {
    expect(h.stale).toBe(false);
    expect(current.slice(h.from!, h.to!)).toBe(P.hunks[h.index]!.oldText);
    expect(h.status).toBe('pending');
  }
  // A hunk whose text is gone starts out stale, with no position.
  const gone = locateHunks(BASE.replace('Last sentence', 'Final words'), P);
  expect(gone.hunks[1]).toMatchObject({ from: null, to: null, stale: true });
  expect(gone.hunks[0]!.stale).toBe(false);
});

describe('finishPlan', () => {
  const inline = (
    statuses: ('pending' | 'accepted' | 'rejected')[],
    over: Partial<InlineProposal['hunks'][0]>[] = [],
  ) => {
    const located = locateHunks(BASE, P);
    return {
      ...located,
      hunks: located.hunks.map((h, i) => ({ ...h, status: statuses[i]!, ...over[i] })),
    };
  };

  test('waits while a hunk is undecided', () => {
    expect(finishPlan(P, inline(['accepted', 'pending']), BASE)).toEqual({ kind: 'pending' });
  });

  test('accept all: both changes, applied to the right ranges', () => {
    const plan = finishPlan(P, inline(['accepted', 'accepted']), BASE);
    expect(plan.kind).toBe('apply');
    if (plan.kind !== 'apply') return;
    expect(plan.decision).toEqual({
      decision: 'accepted',
      hunks: [
        { index: 0, accepted: true },
        { index: 1, accepted: true },
      ],
    });
    // Applying the changes gives exactly what applyEdits gives on the original.
    let out = BASE;
    for (const c of [...plan.changes].sort((a, b) => b.from - a.from)) {
      out = out.slice(0, c.from) + c.insert + out.slice(c.to);
    }
    expect(out).toBe(
      applyEdits(
        BASE,
        P.hunks.map((h) => ({ oldText: h.oldText, newText: h.newText })),
      ).newContent,
    );
  });

  test('accept one with edited text, reject the other', () => {
    const plan = finishPlan(
      P,
      inline(['accepted', 'rejected'], [{ newText: 'My sentence' }]),
      BASE,
    );
    expect(plan).toMatchObject({
      kind: 'apply',
      changes: [{ insert: 'My sentence' }],
      decision: {
        decision: 'accepted',
        hunks: [
          { index: 0, accepted: true, finalText: 'My sentence' },
          { index: 1, accepted: false },
        ],
      },
    });
  });

  test('nothing accepted is a rejection, with the reason', () => {
    expect(finishPlan(P, inline(['rejected', 'rejected']), BASE, ' Keep mine ')).toEqual({
      kind: 'decide',
      decision: { decision: 'rejected', reason: 'Keep mine' },
    });
  });

  test('an accepted hunk the user changed since is stale: nothing is applied', () => {
    const changed = BASE.replace('Last sentence', 'Final words');
    const plan = finishPlan(P, inline(['accepted', 'accepted'], [{}, { stale: true }]), changed);
    expect(plan).toMatchObject({ kind: 'decide', decision: { decision: 'stale' } });
    if (plan.kind === 'decide' && plan.decision.decision === 'stale') {
      expect(plan.decision.currentRegions).toEqual([
        { index: 1, text: regionAround(changed, P, 1) },
      ]);
    }
  });
});

test('regionAround gives the current lines around the hunk', () => {
  const changed = BASE.replace('Last sentence', 'Final words');
  expect(regionAround(changed, P, 1)).toBe(
    ['  \\item', '  \\item', '\\end{itemize}', 'Final words here.', ''].join('\n'),
  );
});

test('revert: inverse edits with context restore the original; repeated \\item lines stay unambiguous', () => {
  const items = proposal([{ oldText: '  \\item\n\\end', newText: '  \\item Third\n\\end' }]);
  const decisions = [{ index: 0, accepted: true }];
  const applied = applyEdits(
    BASE,
    acceptedEdits(items, decisions).map((e) => e.edit),
  ).newContent;
  const inverse = revertEdits(items, decisions);
  expect(canRevert(applied, inverse)).toBe(true);
  expect(applyEdits(applied, inverse).newContent).toBe(BASE);
});

test('revert uses the text the user edited the hunk to', () => {
  const decisions = [
    { index: 0, accepted: true, finalText: 'My own sentence' },
    { index: 1, accepted: false },
  ];
  const applied = applyEdits(
    BASE,
    acceptedEdits(P, decisions).map((e) => e.edit),
  ).newContent;
  expect(applied).toContain('My own sentence here.');
  expect(applyEdits(applied, revertEdits(P, decisions)).newContent).toBe(BASE);
});

test('revert is offered only while the applied regions are unchanged', () => {
  const decisions = [{ index: 0, accepted: true }];
  const applied = applyEdits(
    BASE,
    acceptedEdits(P, decisions).map((e) => e.edit),
  ).newContent;
  const inverse = revertEdits(P, decisions);
  expect(canRevert(applied, inverse)).toBe(true);
  expect(canRevert(applied.replace('Opening sentence', 'Opening line'), inverse)).toBe(false);
  // Edits elsewhere don't matter.
  expect(canRevert(applied.replace('Closing', 'x').replace('Last', 'Final'), inverse)).toBe(true);
  // Nothing accepted: nothing to revert.
  expect(canRevert(applied, revertEdits(P, [{ index: 0, accepted: false }]))).toBe(false);
});

test('revert works for hunks close together (their contexts must not overlap)', () => {
  const close = proposal([
    { oldText: 'First', newText: 'Opening' },
    { oldText: 'sentence here.\n\\begin', newText: 'line here.\n\\begin' },
  ]);
  const decisions = [
    { index: 0, accepted: true },
    { index: 1, accepted: true },
  ];
  const applied = applyEdits(
    BASE,
    acceptedEdits(close, decisions).map((e) => e.edit),
  ).newContent;
  const inverse = revertEdits(close, decisions);
  expect(canRevert(applied, inverse)).toBe(true);
  expect(applyEdits(applied, inverse).newContent).toBe(BASE);
});
