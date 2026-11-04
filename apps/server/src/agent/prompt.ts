import { join } from 'node:path';

import type { ProjectTool } from './tools/index.ts';

const PREAMBLE = `You are an expert LaTeX assistant built into a local LaTeX editor. The user is writing a document in the project described below, and you help them write, fix and improve it. You can inspect and compile the project, and propose changes that the user reviews before they are applied. Be concise: say what you found or changed, not how you went about it.`;

const RULES = [
  'After the user accepts a change that can affect the PDF, compile and report the result.',
  "Don't rename \\cite keys, \\label or \\ref names unless the user's current message asks for it.",
  'To fix a compile error, read the referenced file around the reported line before changing anything.',
  "Keep edits minimal: change only what the task needs and keep the author's wording, formatting and macros.",
  "Change the preamble, \\documentclass, .cls or .sty files only when the user's current message asks for it; otherwise ask first.",
  "Never invent citations: cite only keys that exist in the project's .bib files. If a needed source is missing, say so.",
];

export interface PromptInput {
  projectRoot: string;
  tools: ProjectTool[];
}

/** System prompt: preamble, tools, rules, then project context including AGENTS.md if present. */
export async function buildSystemPrompt({ projectRoot, tools }: PromptInput): Promise<string> {
  const rules = [...new Set([...tools.flatMap((t) => t.guidelines), ...RULES])];
  const sections = [
    PREAMBLE,
    `# Tools\n${tools.map((t) => `- ${t.snippet}`).join('\n')}`,
    `# Rules\n${rules.map((r) => `- ${r}`).join('\n')}`,
    `# Project\nThe compile root is chosen automatically: a "% !TEX root" comment in the file, the project setting, the only .tex file with \\documentclass, or main.tex.`,
    `# Editor state\nThe user's latest message starts with an <editor_state> block, refreshed before each of your requests: the file they have open, their cursor line and selection, files with unsaved edits, and the last compile. "This", "here" or "the selection" refer to it. The block comes from the editor, not from the user's typing; don't quote it back.`,
  ];

  const agentsFile = Bun.file(join(projectRoot, 'AGENTS.md'));
  if (await agentsFile.exists()) {
    const instructions = (await agentsFile.text()).trim();
    if (instructions) sections.push(`# Project instructions (from AGENTS.md)\n${instructions}`);
  }
  return sections.join('\n\n');
}
