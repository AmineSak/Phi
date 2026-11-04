/// <reference types="bun" />
import { expect, test } from 'bun:test';

import { buildTree, type TreeNode } from '../tree.ts';

const outline = (nodes: TreeNode[], depth = 0): string[] =>
  nodes.flatMap((n) => [
    `${'  '.repeat(depth)}${n.name}${n.isDir ? '/' : ''}`,
    ...outline(n.children, depth + 1),
  ]);

test('nests paths, folders before files, alphabetical within each', () => {
  const tree = buildTree([
    { path: 'main.tex', isDir: false, kind: 'text' },
    { path: 'chapters', isDir: true },
    { path: 'chapters/intro.tex', isDir: false, kind: 'text' },
    { path: 'chapters/appendix', isDir: true },
    { path: 'chapters/appendix/proofs.tex', isDir: false, kind: 'text' },
    { path: 'Abstract.tex', isDir: false, kind: 'text' },
    { path: 'refs.bib', isDir: false, kind: 'text' },
    { path: 'figures', isDir: true },
  ]);
  expect(outline(tree)).toEqual([
    'chapters/',
    '  appendix/',
    '    proofs.tex',
    '  intro.tex',
    'figures/',
    'Abstract.tex',
    'main.tex',
    'refs.bib',
  ]);
  expect(tree[0]?.children[1]?.path).toBe('chapters/intro.tex');
});

test('an empty project is an empty tree', () => {
  expect(buildTree([])).toEqual([]);
});
