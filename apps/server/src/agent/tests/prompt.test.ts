import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPending } from '../pending.ts';
import { buildSystemPrompt } from '../prompt.ts';
import { createProjectTools, type ProjectTool } from '../tools/index.ts';
import { createWorkspace } from '../workspace.ts';

let root: string;
let tools: ProjectTool[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prompt-test-'));
  tools = createProjectTools(root, createWorkspace(root), createPending({ onSettled: () => {} }));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

test('the base prompt lists every tool and stays under 600 words', async () => {
  const prompt = await buildSystemPrompt({ projectRoot: root, tools });
  for (const { snippet } of tools) expect(prompt).toContain(`- ${snippet}`);
  expect(words(prompt)).toBeLessThan(600);
  expect(prompt).not.toContain('AGENTS.md');
});

test('includes the fixed rules', async () => {
  const prompt = await buildSystemPrompt({ projectRoot: root, tools });
  expect(prompt).toContain('compile and report the result');
  expect(prompt).toContain('around the reported line');
  expect(prompt).toContain('Keep edits minimal');
  expect(prompt).toContain("only when the user's current message asks");
  expect(prompt).toContain('<editor_state>');
  expect(prompt).toContain('Never invent citations');
});

test('merges tool guidelines and deduplicates identical lines', async () => {
  const shared = 'Paths are relative to the project root, e.g. chapters/intro.tex.';
  expect(tools.filter((t) => t.guidelines.includes(shared)).length).toBeGreaterThan(1);
  const prompt = await buildSystemPrompt({ projectRoot: root, tools });
  expect(prompt.split(shared).length - 1).toBe(1);
});

test('appends AGENTS.md as project instructions when present', async () => {
  writeFileSync(join(root, 'AGENTS.md'), '  Use British spelling.\n');
  const prompt = await buildSystemPrompt({ projectRoot: root, tools });
  expect(prompt).toEndWith('# Project instructions (from AGENTS.md)\nUse British spelling.');
});

test('skips an empty AGENTS.md', async () => {
  writeFileSync(join(root, 'AGENTS.md'), '\n');
  expect(await buildSystemPrompt({ projectRoot: root, tools })).not.toContain('AGENTS.md');
});
