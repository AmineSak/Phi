import { describe, expect, test } from 'bun:test';

import { MAX_UPLOAD_BYTES } from '@phi/shared';

import { bytes, SAMPLES } from '../upload-samples.ts';
import { checkUpload, UploadError } from '../upload.ts';

const rejects = (path: string, data: Uint8Array, status: 400 | 413, message: string | RegExp) => {
  let error: unknown;
  try {
    checkUpload(path, data);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(UploadError);
  expect((error as UploadError).status).toBe(status);
  expect((error as UploadError).message).toMatch(message);
};

describe('accepted', () => {
  test('each allowed type with matching content, any extension case', () => {
    expect(() => checkUpload('figures/plot.png', SAMPLES.png)).not.toThrow();
    expect(() => checkUpload('photo.jpg', SAMPLES.jpg)).not.toThrow();
    expect(() => checkUpload('photo.JPEG', SAMPLES.jpg)).not.toThrow();
    expect(() => checkUpload('paper.pdf', SAMPLES.pdf)).not.toThrow();
    expect(() => checkUpload('fig.eps', SAMPLES.eps)).not.toThrow();
    expect(() => checkUpload('fig.eps', SAMPLES.dosEps)).not.toThrow();
    expect(() => checkUpload('logo.svg', SAMPLES.svg)).not.toThrow();
  });

  test('svg with a BOM, XML declaration, comment and doctype before <svg>', () => {
    const svg = bytes(
      '﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- made by hand -->\n' +
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    expect(() => checkUpload('logo.svg', svg)).not.toThrow();
  });

  test('exactly 20 MB is accepted', () => {
    const data = new Uint8Array(MAX_UPLOAD_BYTES);
    data.set(SAMPLES.png);
    expect(() => checkUpload('big.png', data)).not.toThrow();
  });
});

describe('rejected', () => {
  test('disallowed or missing extensions', () => {
    rejects('notes.tex', SAMPLES.png, 400, /Only png, jpg, jpeg, pdf, eps, svg/);
    rejects('script.js', SAMPLES.png, 400, /"script.js"/);
    rejects('noextension', SAMPLES.png, 400, /Only/);
    rejects('photo.gif', SAMPLES.png, 400, /Only/);
  });

  test('over 20 MB is 413', () => {
    const data = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    data.set(SAMPLES.png);
    rejects('big.png', data, 413, /20 MB/);
  });

  test('empty files', () => {
    rejects('empty.png', new Uint8Array(), 400, /empty/);
  });

  test('content that does not match the extension', () => {
    rejects('fake.png', SAMPLES.jpg, 400, /not a valid \.png/);
    rejects('fake.jpg', SAMPLES.png, 400, /not a valid \.jpg/);
    rejects('fake.pdf', bytes('<html>'), 400, /not a valid \.pdf/);
    rejects('fake.eps', SAMPLES.pdf, 400, /not a valid \.eps/);
  });

  test('svg that is not XML, not well-formed, or not rooted at <svg>', () => {
    rejects('a.svg', SAMPLES.png, 400, /not valid UTF-8|not well-formed/);
    rejects('a.svg', bytes('just text'), 400, /not well-formed/);
    rejects('a.svg', bytes('<svg><rect></svg>'), 400, /not well-formed/);
    rejects('a.svg', bytes('<html><body/></html>'), 400, /does not start with an <svg>/);
    rejects('a.svg', bytes('<svgfoo/>'), 400, /does not start with an <svg>/);
  });
});
