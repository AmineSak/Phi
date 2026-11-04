// Agent tool names, as the LLM sees them. Use these constants, never string literals.

export const READ_FILE = 'read_file';
export const LIST_FILES = 'list_files';
export const SEARCH = 'search';
export const COMPILE = 'compile';
export const PROPOSE_EDIT = 'propose_edit';
export const PROPOSE_FILE_OP = 'propose_file_op';

export type ToolName =
  | typeof READ_FILE
  | typeof LIST_FILES
  | typeof SEARCH
  | typeof COMPILE
  | typeof PROPOSE_EDIT
  | typeof PROPOSE_FILE_OP;
