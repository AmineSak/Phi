import * as compile from './compile.ts';
import * as listFiles from './list-files.ts';
import * as proposeEdit from './propose-edit.ts';
import * as proposeFileOp from './propose-file-op.ts';
import * as readFile from './read-file.ts';
import * as search from './search.ts';
import type { Pending } from '../pending.ts';
import type { Workspace } from '../workspace.ts';
import type { ProjectTool } from './types.ts';

export type { ProjectTool } from './types.ts';

/** All agent tools for the project at `root`, in the order the prompt lists them. */
export function createProjectTools(
  root: string,
  workspace: Workspace,
  pending: Pending,
): ProjectTool[] {
  return [
    { tool: listFiles.createListFilesTool(root), ...listFiles },
    { tool: readFile.createReadFileTool(root, workspace), ...readFile },
    { tool: search.createSearchTool(root, workspace), ...search },
    { tool: compile.createCompileTool(root, workspace), ...compile },
    { tool: proposeEdit.createProposeEditTool(root, workspace, pending), ...proposeEdit },
    { tool: proposeFileOp.createProposeFileOpTool(root, pending), ...proposeFileOp },
  ].map(({ tool, snippet, guidelines }) => ({ tool, snippet, guidelines }));
}
