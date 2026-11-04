// REST contracts. Paths in requests and responses are POSIX-style and relative
// to PROJECT_ROOT (e.g. "chapters/intro.tex").

import type {
  EditProposal,
  FileOpProposal,
  ReviewOutcome,
  UnsequencedWireEvent,
  Usage,
} from './wire.ts';

/** Body of any non-2xx /api response. */
export interface ApiError {
  error: string;
}

/** GET /api/health */
export interface HealthResponse {
  ok: true;
  /** Lets `phi` tell its own server from anything else on the port. */
  app: 'phi';
  projectRoot: string | null;
}

/**
 * What a file is, by extension. Only "text" opens in the editor; images and PDFs are
 * previewed; anything else is listed but not opened (SPEC 4.2).
 */
export type FileKind = 'text' | 'image' | 'pdf' | 'binary';

export type FileEntry =
  { path: string; isDir: true } | { path: string; isDir: false; kind: FileKind };

/** POST /api/files: creates an empty folder, or a file with optional content. 409 if it exists. */
export type CreateFileRequest =
  { path: string; type: 'dir' } | { path: string; type: 'file'; content?: string };

/** POST /api/files, 201 */
export interface CreateFileResponse {
  path: string;
}

/** POST /api/files/rename: moves a file or folder. 409 if `to` exists. */
export interface RenameRequest {
  from: string;
  to: string;
}

/** POST /api/files/rename, 200 */
export interface RenameResponse {
  from: string;
  to: string;
}

/** DELETE /api/files/{path}, 200: the item was moved to the trash, never deleted (SPEC 4.1). */
export interface DeleteResponse {
  path: string;
  /** Where it went, e.g. ".latex-agent/trash/2026-10-25T12-00-00-000Z/figures/old.png". */
  trashPath: string;
}

/** Files that may be uploaded, and the largest size accepted (SPEC 4.2). */
export const UPLOAD_EXTENSIONS = ['png', 'jpg', 'jpeg', 'pdf', 'eps', 'svg'] as const;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * POST /api/upload/{path} with the raw file as the body. 409 if the file exists, unless
 * `?replace=1`, which moves the old file to the trash first. 400 for a type or content that
 * doesn't match, 413 when too large.
 */
export interface UploadResponse {
  path: string;
  kind: FileKind;
  size: number;
}

/** How the compile root was chosen (SPEC 4.3), in priority order. */
export type RootSource = 'magic-comment' | 'settings' | 'documentclass' | 'main.tex';

/** GET /api/root?activeFile=…: the file that would be compiled. */
export interface RootResponse {
  root: string;
  source: RootSource;
}

/** POST /api/compile body. The root is resolved from the active file (SPEC 4.3). */
export interface CompileRequest {
  activeFile?: string;
}

/** GET /api/files */
export type ListFilesResponse = FileEntry[];

/** GET /api/files/{path} */
export interface ReadFileResponse {
  path: string;
  content: string;
  mtimeMs: number;
}

/**
 * PUT /api/files/{path}
 * `baseMtimeMs` is the mtime the client last read. If the file changed since,
 * the server answers 409 with a FileConflictError instead of writing.
 */
export interface WriteFileRequest {
  content: string;
  baseMtimeMs?: number;
}

/** PUT /api/files/{path}, 200 */
export interface WriteFileResponse {
  mtimeMs: number;
}

/** PUT /api/files/{path}, 409 */
export interface FileConflictError extends ApiError {
  error: 'conflict';
  path: string;
  /** mtime of the file currently on disk, or null if it was deleted. */
  mtimeMs: number | null;
}

export interface CompileError {
  file: string;
  line: number | null;
  message: string;
}

/** POST /api/compile */
export interface CompileResult {
  /** The root file that was compiled; the PDF is next to it (thesis.tex → thesis.pdf). */
  root: string;
  ok: boolean;
  durationMs: number;
  errors: CompileError[];
  warnings: CompileError[];
  /** Last lines of the LaTeX log, for display when parsing found nothing useful. */
  logTail: string;
}

/** Limits on an EditorSnapshot; the server rejects snapshots over them with 400. */
export const MAX_SNAPSHOT_DIRTY_FILES = 5;
export const MAX_SNAPSHOT_DIRTY_BYTES = 200 * 1024;
export const MAX_SELECTION_CHARS = 2000;

/** What the user sees in the editor, sent so the agent sees it too (SPEC 5.7). */
export interface EditorSnapshot {
  /** Project-relative path of the active tab, or null when none is open. */
  activeFile: string | null;
  /** 1-based cursor line in the active file, or null when no text file is shown. */
  cursorLine: number | null;
  /** Selected text in the active file: 1-based first and last line, text cut to 2000 chars. */
  selection?: { from: number; to: number; text: string };
  /** Open files with unsaved edits: at most 5, 200 KB of content in total (UTF-8). */
  dirtyFiles: { path: string; content: string }[];
  /** Tool calls whose applied edit the user reverted since the last request (milestone 11). */
  revertedToolCallIds: string[];
}

/** POST /api/threads/:id/messages body. */
export interface SendMessageRequest {
  text: string;
  /** Client-chosen id, echoed in the user_message event so the sender can match it. */
  messageId?: string;
  /** The editor as the user sees it when sending. */
  snapshot?: EditorSnapshot;
}

/** POST /api/threads/:id/messages, 202: a run started, or the message was queued for the running one. */
export type SendMessageResponse = { runId: string } | { queued: true };

/** POST /api/threads/:id/messages, 400 when the model provider has no API key configured. */
export interface NoApiKeyError extends ApiError {
  error: 'no_api_key';
  /** The environment variable that holds the key for the configured provider. */
  envVar: string;
  /** The provider's name, e.g. "Claude". */
  provider: string;
}

/** 409 body when a create, rename target or upload would overwrite something. */
export interface ExistsErrorBody extends ApiError {
  error: 'exists';
  /** The path that already exists. */
  path: string;
  message: string;
}

/** A user's decision on one hunk of an edit proposal. */
export interface HunkDecision {
  /** Index into the proposal's hunks. */
  index: number;
  accepted: boolean;
  /** The text the user edited the hunk's new text into, when they changed it. */
  finalText?: string;
}

/**
 * POST /api/threads/:id/reviews/:toolCallId body (SPEC 3.2, 3.4). `hunks` is required for an
 * edit proposal and absent for a file operation.
 */
export type ReviewDecisionRequest =
  | { decision: 'accepted'; hunks?: HunkDecision[] }
  | { decision: 'rejected'; reason?: string }
  | { decision: 'stale'; currentRegions: { index: number; text: string }[] };

/** 200 response; `created` is set when an accepted file operation created a file. */
export interface ReviewDecisionResponse {
  toolCallId: string;
  decision: ReviewDecisionRequest['decision'];
  created?: { path: string; content: string };
}

/** 409 body when the proposal was already decided (another tab was first) or is gone. */
export interface ReviewConflictError extends ApiError {
  error: 'already_decided';
  message: string;
}

/** `details` of a finished propose_edit / propose_file_op tool call, for its card and Revert. */
export interface ReviewToolDetails {
  proposal: EditProposal | FileOpProposal;
  outcome: ReviewOutcome;
  /** Per-hunk decisions of an accepted edit proposal. */
  hunks?: HunkDecision[];
}

/** A chat thread in the list (SPEC 5.4). Times are epoch milliseconds. */
export interface ThreadSummary {
  id: string;
  /** Empty until the first run ends, then the start of the first message. */
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Sum over every model response in the thread. */
  usage: Usage;
}

/** GET /api/threads: most recently updated first. POST /api/threads returns one summary (201). */
export type ThreadListResponse = ThreadSummary[];

/**
 * GET /api/threads/:id/messages: the thread's stored history as wire events (without seq),
 * to be reduced before the live stream is opened. The stream carries everything after it.
 */
export interface ThreadHistoryResponse {
  thread: ThreadSummary;
  events: UnsequencedWireEvent[];
}

/** GET /api/settings and the response of PUT (SPEC 7.1). The key itself is never sent. */
/** Model providers the user can switch between in Settings (SPEC 7.1). */
export const PROVIDER_IDS = ['openrouter', 'anthropic', 'openai', 'mistral'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const isProviderId = (value: unknown): value is ProviderId =>
  typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);

/** One provider in Settings: whether it has a key. The key itself is never sent. */
export interface ProviderStatus {
  id: ProviderId;
  /** "Claude", "OpenAI"… */
  name: string;
  /** Who makes it, when the name alone doesn't say (Claude → "Anthropic"). */
  vendor: string;
  keyConfigured: boolean;
  /** Last 4 characters of the key in use, e.g. "…a1b2". */
  keyHint: string | null;
  keySource: 'env' | 'settings' | null;
  /** The environment variable that overrides a stored key. */
  envVar: string;
  /** Where to create a key. */
  keyUrl: string;
  /** The model used with this provider, chosen or default. */
  model: string;
  modelCount: number;
}

export interface SettingsResponse {
  /** The provider the next run uses ("faux" in offline tests). */
  provider: string;
  /** LLM_PROVIDER in .env pins it; otherwise it is chosen in Settings. */
  providerSource: 'env' | 'settings' | 'default';
  /** Every provider that can be chosen, with its key state. Empty in offline (faux) mode. */
  providers: ProviderStatus[];
  /** The model the next run uses. */
  model: string;
  /** Where it comes from: LLM_MODEL in .env wins over the settings file. */
  modelSource: 'env' | 'settings' | 'default';
  /** Set when the chosen model is not usable (e.g. no longer in the catalog). */
  modelError?: string;
  /** The active provider's models. */
  models: { id: string; name: string; contextWindow: number }[];
  /** The rest describe the active provider's key. */
  apiKeyConfigured: boolean;
  /** Last 4 characters of the key in use, e.g. "…a1b2"; null without a key. */
  apiKeyHint: string | null;
  apiKeySource: 'env' | 'settings' | null;
  /** The environment variable that would override the stored key. */
  apiKeyEnvVar: string;
}

/**
 * PUT /api/settings body. Applied in order: `provider` switches the active provider, `model`
 * and `apiKey` apply to the (new) active one, `apiKeys` set keys of any provider. "" clears a
 * key or a model (back to the default).
 */
export interface UpdateSettingsRequest {
  provider?: ProviderId;
  model?: string;
  apiKey?: string;
  apiKeys?: Partial<Record<ProviderId, string>>;
}

/** GET /api/project, and the response of POST /api/project (SPEC 4.4). */
export interface ProjectResponse {
  /** Absolute folder of the open project; null before one is opened. */
  root: string | null;
  /** Absolute folders, most recent first. */
  recent: string[];
}

/** GET /api/lsp/status: whether texlab (LaTeX completion) can run. */
export interface LspStatusResponse {
  available: boolean;
  /** e.g. "texlab 5.26.0"; null when it isn't installed. */
  version: string | null;
}

/** POST /api/project body. */
export interface OpenProjectRequest {
  path: string;
}

/** GET /api/synctex/edit?pdf&page&x&y: where a PDF spot comes from (SPEC 6.4). */
export interface SynctexSource {
  file: string;
  line: number;
  /** null when SyncTeX doesn't know the column (usual). */
  column: number | null;
}

/**
 * GET /api/synctex/view?file&line&column&pdf: where a source line is typeset. A box in PDF big
 * points from the page's top-left corner.
 */
export interface SynctexBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** GET /api/threads/:id/status: whether a run is active, for clients that lost events (SPEC 8.3). */
export interface ThreadStatusResponse {
  running: boolean;
  runId: string | null;
}
