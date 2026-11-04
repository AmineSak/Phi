import type { AgentTool } from '@earendil-works/pi-agent-core';
import { COMPILE, fileKind, type CompileError, type CompileResult } from '@phi/shared';
import { Type } from 'typebox';

import { compiledInputs, compileProject } from '../../services/project-compile.ts';
import { resolveRoot } from '../../services/root-file.ts';
import type { Workspace } from '../workspace.ts';
import { textContent } from './types.ts';

export const snippet = `${COMPILE}: build the project with latexmk; returns the root file, errors with file:line and a warning count.`;

export const guidelines = [
  `A failed ${COMPILE} lists errors as file:line: message; fix the first error first, since later ones often follow from it.`,
];

const TAIL_LINES = 15;

const parameters = Type.Object({});

function formatError({ file, line, message }: CompileError): string {
  if (file && line !== null) return `${file}:${line}: ${message}`;
  return file ? `${file}: ${message}` : message;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The compact text the model sees; the full CompileResult goes to the UI via details. */
export function summarizeCompile(result: CompileResult): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  const warnings = plural(result.warnings.length, 'warning');
  if (result.ok) return `Compiled ${result.root} successfully in ${seconds} s, ${warnings}.`;

  const lines = [
    `Compiling ${result.root} failed in ${seconds} s with ${plural(result.errors.length, 'error')} and ${warnings}:`,
    ...result.errors.map(formatError),
  ];
  const unlocated =
    result.errors.length === 0 || result.errors.some((e) => !e.file || e.line === null);
  if (unlocated) {
    const tail = result.logTail.split('\n').slice(-TAIL_LINES).join('\n');
    lines.push('', `Last ${TAIL_LINES} log lines:`, tail);
  }
  return lines.join('\n');
}

/** The active text file, which may name its root with a "% !TEX root" comment. */
function activeTextFile(workspace: Workspace): string | undefined {
  const active = workspace.snapshot?.activeFile;
  return active && fileKind(active) === 'text' ? active : undefined;
}

/** A note for files the compile read from disk while the editor holds unsaved changes. */
async function unsavedNote(root: string, rootFile: string, workspace: Workspace) {
  const inputs = new Set([rootFile, ...(await compiledInputs(root, rootFile))]);
  const unsaved = (workspace.snapshot?.dirtyFiles ?? [])
    .map((f) => f.path)
    .filter((path) => inputs.has(path));
  if (unsaved.length === 0) return '';
  return (
    `\n\nNote: ${unsaved.join(', ')} ${unsaved.length === 1 ? 'has' : 'have'} unsaved edits in ` +
    'the editor that this compile did not include (it reads the files on disk). The editor ' +
    'autosaves about a second after typing stops; compile again to include them.'
  );
}

export function createCompileTool(
  root: string,
  workspace: Workspace,
): AgentTool<typeof parameters, CompileResult> {
  return {
    name: COMPILE,
    label: 'Compile',
    description:
      'Compile the project with latexmk and report errors and warnings. It compiles the files on disk. The root file is chosen automatically: a "% !TEX root" comment in the active file, the project setting, the only .tex file with \\documentclass, or main.tex.',
    parameters,
    execute: async (_toolCallId, _params, signal) => {
      // The root follows the file the user has open, as the Compile button does (SPEC 4.3).
      const { root: rootFile } = await resolveRoot(root, activeTextFile(workspace));
      const result = await compileProject(root, rootFile, signal);
      const note = await unsavedNote(root, rootFile, workspace);
      return { content: textContent(summarizeCompile(result) + note), details: result };
    },
  };
}
