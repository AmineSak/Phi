import type { AgentTool } from '@earendil-works/pi-agent-core';
import { SEARCH } from '@phi/shared';
import { Type } from 'typebox';

import { MAX_MATCHES, searchProject } from '../../services/search.ts';
import type { Workspace } from '../workspace.ts';
import { textContent } from './types.ts';

export const snippet = `${SEARCH}: find text or a regex in .tex/.bib/.sty/.cls files; returns file:line: text.`;

export const guidelines = [
  `Use ${SEARCH} to find labels, citation keys and macro definitions instead of reading every file.`,
];

const parameters = Type.Object({
  query: Type.String({ description: 'Text to find (case-insensitive), or a regex if isRegex' }),
  isRegex: Type.Optional(
    Type.Boolean({ description: 'Treat query as a case-sensitive JavaScript regex' }),
  ),
});

export function createSearchTool(
  root: string,
  workspace: Workspace,
): AgentTool<typeof parameters, { matches: number; limited: boolean }> {
  return {
    name: SEARCH,
    label: 'Search',
    description:
      `Search the project's .tex, .bib, .sty and .cls files line by line, including unsaved edits. Returns up to ` +
      `${MAX_MATCHES} matches as "file:line: text", lines trimmed to 200 characters.`,
    parameters,
    execute: async (_toolCallId, { query, isRegex }, signal) => {
      const { matches, limited } = await searchProject(
        root,
        query,
        isRegex,
        signal,
        workspace.readText,
      );
      const lines = matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
      if (limited) lines.push(`[stopped at ${MAX_MATCHES} matches; narrow the query]`);
      return {
        content: textContent(
          lines.length ? lines.join('\n') : `No matches for ${JSON.stringify(query)}.`,
        ),
        details: { matches: matches.length, limited },
      };
    },
  };
}
