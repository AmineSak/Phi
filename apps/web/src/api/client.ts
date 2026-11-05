import type {
  ApiError,
  CompileRequest,
  CompileResult,
  CreateProjectRequest,
  CreateFileRequest,
  CreateFileResponse,
  DeleteResponse,
  ExistsErrorBody,
  FileConflictError,
  HealthResponse,
  ListFilesResponse,
  LspStatusResponse,
  OpenProjectRequest,
  ProjectResponse,
  ProjectsResponse,
  ReadFileResponse,
  RenameRequest,
  RenameResponse,
  RootResponse,
  SettingsResponse,
  SynctexBox,
  SynctexSource,
  TemplateInfo,
  UpdateSettingsRequest,
  UploadResponse,
  WriteFileRequest,
  WriteFileResponse,
} from '@phi/shared';

/** A non-2xx response, with the server's error message. */
export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The PUT was rejected because the file changed on disk since `baseMtimeMs`. */
export class ConflictError extends Error {
  constructor(readonly conflict: FileConflictError) {
    super(`${conflict.path} changed on disk`);
  }
}

/** A create, rename or upload would overwrite `path`. */
export class ExistsError extends Error {
  constructor(readonly path: string) {
    super(`${path} already exists`);
  }
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
const fileUrl = (path: string) => `/api/files/${encodePath(path)}`;
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.ok) return (await res.json()) as T;
  const body = (await res.json().catch(() => null)) as
    ApiError | FileConflictError | ExistsErrorBody | null;
  if (res.status === 409 && body?.error === 'conflict') {
    throw new ConflictError(body as FileConflictError);
  }
  if (res.status === 409 && body?.error === 'exists') {
    throw new ExistsError((body as ExistsErrorBody).path);
  }
  throw new RequestError(res.status, body?.error ?? `${res.status} ${res.statusText}`);
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),

  listFiles: () => request<ListFilesResponse>('/api/files'),

  readFile: (path: string) => request<ReadFileResponse>(fileUrl(path)),

  /** Throws ConflictError when the file changed since `baseMtimeMs`. */
  writeFile: (path: string, body: WriteFileRequest) =>
    request<WriteFileResponse>(fileUrl(path), json('PUT', body)),

  /** Throws ExistsError if something is already at `path`. */
  create: (body: CreateFileRequest) =>
    request<CreateFileResponse>('/api/files', json('POST', body)),

  /** Throws ExistsError if `to` exists. */
  rename: (body: RenameRequest) => request<RenameResponse>('/api/files/rename', json('POST', body)),

  /** Moves the file or folder to .latex-agent/trash. */
  remove: (path: string) => request<DeleteResponse>(fileUrl(path), { method: 'DELETE' }),

  /** Uploads a figure. Throws ExistsError unless `replace` (which trashes the old file). */
  upload: (path: string, file: Blob, replace = false) =>
    request<UploadResponse>(`/api/upload/${encodePath(path)}${replace ? '?replace=1' : ''}`, {
      method: 'POST',
      body: file,
    }),

  /** URL of a file's raw bytes (images, PDFs); `version` busts the browser cache. */
  rawUrl: (path: string, version = 0) => `/api/raw/${encodePath(path)}?v=${version}`,

  /** The root file that would be compiled for `activeFile` (SPEC 4.3). */
  root: (activeFile?: string) =>
    request<RootResponse>(
      `/api/root${activeFile ? `?activeFile=${encodeURIComponent(activeFile)}` : ''}`,
    ),

  compile: (body: CompileRequest) => request<CompileResult>('/api/compile', json('POST', body)),

  /** URL of the PDF built from `root`; `version` busts any cache between compiles. */
  pdfUrl: (root: string, version: number) =>
    `/api/pdf?root=${encodeURIComponent(root)}&v=${version}`,

  /** The source line typeset at (x, y) points on `page` of `pdf` (SPEC 6.4). */
  synctexEdit: (pdf: string, page: number, x: number, y: number) =>
    request<SynctexSource>(
      `/api/synctex/edit?${new URLSearchParams({ pdf, page: String(page), x: String(x), y: String(y) })}`,
    ),

  /** Where `file`:`line` is typeset, in the PDF of the root it compiles under. */
  synctexView: (file: string, line: number, column = 0) =>
    request<SynctexBox>(
      `/api/synctex/view?${new URLSearchParams({ file, line: String(line), column: String(column) })}`,
    ),

  settings: () => request<SettingsResponse>('/api/settings'),
  updateSettings: (body: UpdateSettingsRequest) =>
    request<SettingsResponse>('/api/settings', json('PUT', body)),

  project: () => request<ProjectResponse>('/api/project'),
  openProject: (body: OpenProjectRequest) =>
    request<ProjectResponse>('/api/project', json('POST', body)),

  /** Deployed (SPEC 9.2): the project folders, by name. */
  projects: () => request<ProjectsResponse>('/api/projects'),

  /** Deployed (SPEC 9.2): a new project from a template; the server opens it. */
  createProject: (body: CreateProjectRequest) =>
    request<ProjectResponse>('/api/projects', json('POST', body)),

  templates: () => request<TemplateInfo[]>('/api/templates'),

  lspStatus: () => request<LspStatusResponse>('/api/lsp/status'),
};
