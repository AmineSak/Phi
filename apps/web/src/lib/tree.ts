import type { FileEntry, FileKind } from '@phi/shared';

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  /** Set for files: what opens in the editor, what is previewed (SPEC 4.2). */
  kind?: FileKind;
  children: TreeNode[];
}

/** Nests the flat, sorted file list; folders first, then files, each alphabetical. */
export function buildTree(entries: readonly FileEntry[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', isDir: true, children: [] };
  const dirs = new Map<string, TreeNode>([['', root]]);

  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const slash = entry.path.lastIndexOf('/');
    const parentPath = slash === -1 ? '' : entry.path.slice(0, slash);
    const node: TreeNode = {
      name: entry.path.slice(slash + 1),
      path: entry.path,
      isDir: entry.isDir,
      ...(entry.isDir ? {} : { kind: entry.kind }),
      children: [],
    };
    (dirs.get(parentPath) ?? root).children.push(node);
    if (entry.isDir) dirs.set(entry.path, node);
  }

  const order = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    for (const n of nodes) order(n.children);
  };
  order(root.children);
  return root.children;
}
