import type { AgentTool } from '@earendil-works/pi-agent-core';
import { LIST_FILES } from '@phi/shared';
import { Type } from 'typebox';

import { listFiles } from '../../services/fs.ts';
import { textContent } from './types.ts';

export const snippet = `${LIST_FILES}: list every file and folder in the project.`;

export const guidelines = [
  `Use ${LIST_FILES} to learn the project layout; never guess file names.`,
  'Paths are relative to the project root, e.g. chapters/intro.tex.',
];

const parameters = Type.Object({});

export function createListFilesTool(root: string): AgentTool<typeof parameters, { count: number }> {
  return {
    name: LIST_FILES,
    label: 'List files',
    description:
      'List all files and folders in the project, one path per line; folders end with "/". ' +
      'LaTeX build artifacts (.aux, .log, ...) are left out.',
    parameters,
    execute: async (_toolCallId, _params, signal) => {
      signal?.throwIfAborted();
      const entries = await listFiles(root);
      const lines = entries.map((e) => (e.isDir ? `${e.path}/` : `${e.path} (${e.kind})`));
      return {
        content: textContent(lines.length ? lines.join('\n') : '(the project is empty)'),
        details: { count: entries.length },
      };
    },
  };
}
