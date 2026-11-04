import { createContext, use, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  File,
  FileArchive,
  FileImage,
  FilePlus,
  FileText,
  FileType,
  Folder,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import type { FileKind } from '@phi/shared';

import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  useSidebar,
} from '@/components/ui/sidebar';
import { buildTree, type TreeNode } from '@/lib/tree';
import { cn } from '@/lib/utils';

import {
  createEntry,
  deleteEntry,
  loadFileList,
  openFile,
  renameEntry,
  uploadFiles,
} from '../editor/session.ts';
import { isDirty } from '../editor/views.ts';
import { useCompileStore } from '../store/compile-store.ts';
import { useEditorStore } from '../store/editor-store.ts';
import { folderName, useProjectStore } from '../store/project-store.ts';

const KIND_ICONS: Record<FileKind, typeof File> = {
  text: FileText,
  image: FileImage,
  pdf: FileType,
  binary: FileArchive,
};

type Editing =
  { mode: 'rename'; path: string; name: string } | { mode: 'file' | 'dir'; dir: string };

/** UI state shared by every row: which row is being edited, dropped onto, or deleted. */
interface TreeUi {
  editing: Editing | null;
  setEditing: (editing: Editing | null) => void;
  dropDir: string | null;
  setDropDir: (dir: string | null) => void;
  askDelete: (node: TreeNode) => void;
  upload: (dir: string, files: File[]) => void;
  pickUpload: (dir: string) => void;
}

const TreeUiContext = createContext<TreeUi | null>(null);
const useTreeUi = () => use(TreeUiContext)!;

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');

/** Drop handlers that upload into `dir` (SPEC 4.2). */
function useDropZone(dir: string) {
  const { setDropDir, upload } = useTreeUi();
  return {
    onDragOver: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      setDropDir(dir);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropDir(null);
    },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropDir(null);
      upload(dir, [...e.dataTransfer.files]);
    },
  };
}

/** A name field in place of a row; Enter commits, Escape or leaving cancels. */
function NameInput({
  initial,
  label,
  onCommit,
}: {
  initial: string;
  label: string;
  onCommit: (name: string) => Promise<boolean>;
}) {
  const { setEditing } = useTreeUi();
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    // Select the name without its extension, as file managers do.
    const dot = initial.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  return (
    <Input
      ref={ref}
      value={value}
      aria-label={label}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => setEditing(null)}
      onKeyDown={async (e) => {
        if (e.key === 'Escape') setEditing(null);
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const name = value.trim();
        if (!name || name === initial) return setEditing(null);
        if (await onCommit(name)) setEditing(null);
      }}
      className="h-7 border-sidebar-border bg-sidebar-accent text-sidebar-foreground"
    />
  );
}

/** Row for typing a new file or folder name inside `dir`. */
function NewEntryRow({ dir, type }: { dir: string; type: 'file' | 'dir' }) {
  return (
    <SidebarMenuItem className="px-1">
      <NameInput
        initial=""
        label={type === 'dir' ? 'New folder name' : 'New file name'}
        onCommit={(name) => createEntry(dir, name, type)}
      />
    </SidebarMenuItem>
  );
}

function NodeMenu({ node, children }: { node: TreeNode; children: React.ReactNode }) {
  const { setEditing, askDelete, pickUpload } = useTreeUi();
  const dir = node.isDir ? node.path : parentOf(node.path);
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div />}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={() => setEditing({ mode: 'file', dir })}>
          <FilePlus />
          New file
        </ContextMenuItem>
        <ContextMenuItem onClick={() => setEditing({ mode: 'dir', dir })}>
          <FolderPlus />
          New folder
        </ContextMenuItem>
        <ContextMenuItem onClick={() => pickUpload(dir)}>
          <Upload />
          Upload figures…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => setEditing({ mode: 'rename', path: node.path, name: node.name })}
        >
          <Pencil />
          Rename
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={() => askDelete(node)}>
          <Trash />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function RenameRow({ node }: { node: TreeNode }) {
  return (
    <SidebarMenuItem className="px-1">
      <NameInput
        initial={node.name}
        label={`Rename ${node.name}`}
        onCommit={(name) => {
          const dir = parentOf(node.path);
          return renameEntry(node.path, dir ? `${dir}/${name}` : name);
        }}
      />
    </SidebarMenuItem>
  );
}

function useEntryIdsByFile(): Map<string, string[]> {
  const entries = useCompileStore((s) => s.entries);
  return useMemo(() => {
    const byFile = new Map<string, string[]>();
    for (const e of entries) {
      if (!e.file) continue;
      byFile.set(e.file, [...(byFile.get(e.file) ?? []), e.id]);
    }
    return byFile;
  }, [entries]);
}

function FileNode({ node, entryIds }: { node: TreeNode; entryIds: Map<string, string[]> }) {
  const active = useEditorStore((s) => s.activePath === node.path);
  const isRoot = useCompileStore((s) => s.root === node.path);
  const rootSource = useCompileStore((s) => s.rootSource);
  const { editing } = useTreeUi();
  const { setOpenMobile } = useSidebar();
  const ids = entryIds.get(node.path);
  const Icon = KIND_ICONS[node.kind ?? 'binary'];

  if (editing?.mode === 'rename' && editing.path === node.path) return <RenameRow node={node} />;

  const entryBadge =
    ids && ids.slice(0, 3).join(' ') + (ids.length > 3 ? ` +${ids.length - 3}` : '');
  const badge = [isRoot && 'root', entryBadge].filter(Boolean).join(' · ');

  return (
    <SidebarMenuItem>
      <NodeMenu node={node}>
        <SidebarMenuButton
          isActive={active}
          title={isRoot ? `${node.path} — compile root (${rootSource})` : node.path}
          onClick={() => {
            setOpenMobile(false);
            void openFile(node.path);
          }}
        >
          <Icon />
          <span className={cn('truncate', isRoot && 'font-semibold')}>{node.name}</span>
        </SidebarMenuButton>
        {badge && (
          <SidebarMenuBadge className="font-semibold text-sidebar-muted">{badge}</SidebarMenuBadge>
        )}
      </NodeMenu>
    </SidebarMenuItem>
  );
}

function FolderNode({ node, entryIds }: { node: TreeNode; entryIds: Map<string, string[]> }) {
  const { editing, dropDir } = useTreeUi();
  const drop = useDropZone(node.path);
  const [open, setOpen] = useState(true);
  const adding = editing && editing.mode !== 'rename' && editing.dir === node.path;
  useEffect(() => {
    if (adding) setOpen(true);
  }, [adding]);

  if (editing?.mode === 'rename' && editing.path === node.path) return <RenameRow node={node} />;

  return (
    <SidebarMenuItem
      {...drop}
      className={cn(dropDir === node.path && 'rounded-md ring-2 ring-sidebar-ring')}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <NodeMenu node={node}>
          <CollapsibleTrigger
            render={<SidebarMenuButton />}
            className="[&[data-panel-open]>svg:first-child]:rotate-90"
          >
            <ChevronRight className="transition-transform" />
            <Folder />
            <span className="truncate">{node.name}</span>
          </CollapsibleTrigger>
        </NodeMenu>
        <CollapsibleContent>
          <SidebarMenuSub className="mr-0 pr-0">
            {adding && <NewEntryRow dir={node.path} type={editing.mode} />}
            <TreeNodes nodes={node.children} entryIds={entryIds} />
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  );
}

function TreeNodes({ nodes, entryIds }: { nodes: TreeNode[]; entryIds: Map<string, string[]> }) {
  return nodes.map((node) =>
    node.isDir ? (
      <FolderNode key={node.path} node={node} entryIds={entryIds} />
    ) : (
      <FileNode key={node.path} node={node} entryIds={entryIds} />
    ),
  );
}

/** Asks before moving a file or folder to the trash (SPEC 4.1). */
function DeleteDialog({ node, onClose }: { node: TreeNode | null; onClose: () => void }) {
  const openPaths = useEditorStore((s) => s.openPaths);
  const unsaved =
    node !== null &&
    openPaths.some((p) => (p === node.path || p.startsWith(`${node.path}/`)) && isDirty(p));
  return (
    <AlertDialog open={node !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {node?.name}
            {node?.isDir ? ' and everything in it' : ''}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            It moves to <code>.latex-agent/trash</code> in the project folder, so you can still get
            it back from there.
            {unsaved && ' Unsaved changes in the editor will be lost.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={async () => {
              if (node) await deleteEntry(node.path);
              onClose();
            }}
          >
            Move to trash
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Asks before replacing figures that already exist; the old ones go to the trash. */
function ReplaceDialog({
  pending,
  onClose,
}: {
  pending: { dir: string; files: File[] } | null;
  onClose: () => void;
}) {
  const names = pending?.files.map((f) => f.name).join(', ');
  return (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Replace {pending?.files.length === 1 ? 'this file' : 'these files'}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {names} already {pending?.files.length === 1 ? 'exists' : 'exist'} in{' '}
            {pending?.dir || 'the project folder'}. The current{' '}
            {pending?.files.length === 1 ? 'version moves' : 'versions move'} to{' '}
            <code>.latex-agent/trash</code>.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep existing</AlertDialogCancel>
          <AlertDialogAction
            onClick={async () => {
              if (pending) await uploadFiles(pending.dir, pending.files, true);
              onClose();
            }}
          >
            Replace
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function FileTree() {
  const { isMobile } = useSidebar();
  const files = useEditorStore((s) => s.files);
  const filesError = useEditorStore((s) => s.filesError);
  const fileError = useEditorStore((s) => s.fileError);
  const tree = useMemo(() => buildTree(files), [files]);
  const entryIds = useEntryIdsByFile();
  const root = useProjectStore((s) => s.root);
  const project = root ? folderName(root) : '';
  const [editing, setEditing] = useState<Editing | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TreeNode | null>(null);
  const [replacing, setReplacing] = useState<{ dir: string; files: File[] } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const pickerDir = useRef('');

  const ui: TreeUi = {
    editing,
    setEditing,
    dropDir,
    setDropDir,
    askDelete: setDeleting,
    upload: (dir, dropped) => {
      void uploadFiles(dir, dropped).then(({ existing }) => {
        if (existing.length) setReplacing({ dir, files: existing });
      });
    },
    pickUpload: (dir) => {
      pickerDir.current = dir;
      picker.current?.click();
    },
  };
  return (
    <TreeUiContext value={ui}>
      <Sidebar
        collapsible={isMobile ? 'offcanvas' : 'none'}
        className={isMobile ? undefined : 'h-full w-full'}
      >
        <SidebarHeader className="h-11 justify-center border-b border-sidebar-border px-4">
          <span className="truncate text-sm font-semibold" title={project}>
            {project || 'Project'}
          </span>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup className="flex-1">
            <SidebarGroupLabel className="text-sidebar-muted">Files</SidebarGroupLabel>
            <div className="absolute top-3.5 right-3 flex gap-1">
              <TreeAction label="New file" onClick={() => setEditing({ mode: 'file', dir: '' })}>
                <FilePlus />
              </TreeAction>
              <TreeAction label="New folder" onClick={() => setEditing({ mode: 'dir', dir: '' })}>
                <FolderPlus />
              </TreeAction>
              <TreeAction label="Refresh the file list" onClick={() => void loadFileList()}>
                <RefreshCw />
              </TreeAction>
            </div>
            <RootDropArea>
              {fileError && (
                <Alert variant="destructive" className="mb-2 px-3 py-2">
                  <TriangleAlert />
                  <AlertDescription className="whitespace-pre-line">{fileError}</AlertDescription>
                </Alert>
              )}
              {filesError ? (
                <p className="px-2 text-sm text-sidebar-muted">
                  Could not list files: {filesError}
                </p>
              ) : (
                <SidebarMenu>
                  {editing && editing.mode !== 'rename' && editing.dir === '' && (
                    <NewEntryRow dir="" type={editing.mode} />
                  )}
                  <TreeNodes nodes={tree} entryIds={entryIds} />
                </SidebarMenu>
              )}
              {!filesError && tree.length === 0 && !editing && (
                <p className="px-2 text-sm text-sidebar-muted">
                  The project folder is empty. Create a file or drop figures here.
                </p>
              )}
            </RootDropArea>
          </SidebarGroup>
        </SidebarContent>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept=".png,.jpg,.jpeg,.pdf,.eps,.svg"
          onChange={(e) => {
            ui.upload(pickerDir.current, [...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <DeleteDialog node={deleting} onClose={() => setDeleting(null)} />
        <ReplaceDialog pending={replacing} onClose={() => setReplacing(null)} />
      </Sidebar>
    </TreeUiContext>
  );
}

function TreeAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <SidebarGroupAction title={label} onClick={onClick} className="static">
      {children}
      <span className="sr-only">{label}</span>
    </SidebarGroupAction>
  );
}

/** The empty space around the tree: dropping files there uploads to the project root. */
function RootDropArea({ children }: { children?: React.ReactNode }) {
  const drop = useDropZone('');
  const { dropDir } = useTreeUi();
  return (
    <SidebarGroupContent
      {...drop}
      className={cn('min-h-24 flex-1 rounded-md', dropDir === '' && 'ring-2 ring-sidebar-ring')}
    >
      {children}
    </SidebarGroupContent>
  );
}
