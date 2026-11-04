/// <reference types="bun" />
import { expect, test } from 'bun:test';

import { fileKind, pdfPathFor } from '../files.ts';

test('fileKind by extension, case-insensitive', () => {
  expect(
    [
      'main.tex',
      'refs.BIB',
      'my.sty',
      'a.cls',
      'plain.bst',
      'notes.txt',
      'README.md',
      'data.csv',
      'latexmkrc',
      'fig.png',
      'photo.JPG',
      'p.jpeg',
      'logo.svg',
      'plot.eps',
      'paper.pdf',
      'archive.zip',
      'Makefile',
      'noext',
      '.gitignore',
      'chapters/intro.tex',
    ].map((p) => [p, fileKind(p)]),
  ).toEqual([
    ['main.tex', 'text'],
    ['refs.BIB', 'text'],
    ['my.sty', 'text'],
    ['a.cls', 'text'],
    ['plain.bst', 'text'],
    ['notes.txt', 'text'],
    ['README.md', 'text'],
    ['data.csv', 'text'],
    ['latexmkrc', 'text'],
    ['fig.png', 'image'],
    ['photo.JPG', 'image'],
    ['p.jpeg', 'image'],
    ['logo.svg', 'image'],
    ['plot.eps', 'image'],
    ['paper.pdf', 'pdf'],
    ['archive.zip', 'binary'],
    ['Makefile', 'text'],
    ['noext', 'binary'],
    ['.gitignore', 'text'],
    ['chapters/intro.tex', 'text'],
  ]);
});

test('pdfPathFor puts the PDF next to its root', () => {
  expect(pdfPathFor('main.tex')).toBe('main.pdf');
  expect(pdfPathFor('thesis/thesis.tex')).toBe('thesis/thesis.pdf');
  expect(pdfPathFor('v1.2/paper.ltx')).toBe('v1.2/paper.pdf');
});
