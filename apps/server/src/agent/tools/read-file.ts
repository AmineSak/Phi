import type { AgentTool } from '@earendil-works/pi-agent-core';
import { fileKind, READ_FILE } from '@phi/shared';
import { Type } from 'typebox';

import { pageLines } from '../../services/fs.ts';
import { resolveInProject } from '../../services/paths.ts';
import type { Workspace } from '../workspace.ts';
import { textContent } from './types.ts';

export const snippet = `${READ_FILE}: read a file's lines, paged (at most 2000 lines or 50 KB per call).`;

export const guidelines = [
  'Read a file before changing it.',
  `When ${READ_FILE} output is truncated, continue with the offset it gives rather than starting over.`,
  'Paths are relative to the project root, e.g. chapters/intro.tex.',
];

const parameters = Type.Object({
  path: Type.String({ description: 'File path relative to the project root' }),
  offset: Type.Optional(
    Type.Integer({ minimum: 1, description: '1-based line to start from (default 1)' }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, description: 'Maximum number of lines (default and cap 2000)' }),
  ),
});

interface ReadFileDetails {
  path: string;
  totalLines: number;
  truncated: boolean;
  nextOffset?: number;
}

export function createReadFileTool(
  root: string,
  workspace: Workspace,
): AgentTool<typeof parameters, ReadFileDetails> {
  return {
    name: READ_FILE,
    label: 'Read file',
    description:
      'Read a text file from the project, including unsaved edits open in the editor. Output is capped at 2000 lines or 50 KB; when cut, it ' +
      'ends with "[truncated: N more lines, continue with offset=X]".',
    parameters,
    execute: async (_toolCallId, { path, offset, limit }, signal) => {
      signal?.throwIfAborted();
      resolveInProject(root, path); // path errors come before the kind check
      const kind = fileKind(path);
      if (kind !== 'text') {
        const what = kind === 'image' ? 'an image' : kind === 'pdf' ? 'a PDF' : 'a binary file';
        throw new Error(
          `${path} is ${what}; ${READ_FILE} only reads text files such as .tex, .bib and .sty.`,
        );
      }
      // Unsaved editor buffers win over the disk: the agent reads what the user sees.
      const { text, totalLines, truncated, nextOffset } = pageLines(
        await workspace.readText(path),
        path,
        offset,
        limit,
      );
      return {
        content: textContent(totalLines === 0 ? '(empty file)' : text),
        details: { path, totalLines, truncated, ...(nextOffset ? { nextOffset } : {}) },
      };
    },
  };
}
