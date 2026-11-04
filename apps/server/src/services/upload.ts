import { MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS } from '@phi/shared';
import { SyntaxValidator } from 'fast-xml-validator';

/** An upload that can't be accepted; `status` is the HTTP status to answer with. */
export class UploadError extends Error {
  override name = 'UploadError';
  constructor(
    readonly status: 400 | 413,
    message: string,
  ) {
    super(message);
  }
}

const startsWith = (bytes: Uint8Array, signature: number[]) =>
  signature.every((byte, i) => bytes[i] === byte);

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const PDF = ascii('%PDF-');
const POSTSCRIPT = ascii('%!PS');
/** DOS EPS binary header (EPS with an embedded TIFF/WMF preview). */
const DOS_EPS = [0xc5, 0xd0, 0xd3, 0xc6];

/** Strips a BOM, the XML declaration, comments, processing instructions and a DOCTYPE. */
function afterProlog(text: string): string {
  let rest = text.replace(/^﻿/, '');
  for (;;) {
    const trimmed = rest.trimStart();
    const skip =
      /^<\?[\s\S]*?\?>/.exec(trimmed) ??
      /^<!--[\s\S]*?-->/.exec(trimmed) ??
      /^<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/i.exec(trimmed);
    if (!skip) return trimmed;
    rest = trimmed.slice(skip[0].length);
  }
}

function checkSvg(bytes: Uint8Array): void {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new UploadError(400, 'This .svg is not valid UTF-8 text, so it is not an SVG file.');
  }
  try {
    // Entity expansion is never performed; the limits only bound what a DOCTYPE may declare.
    SyntaxValidator.validate(text, { docType: { maxEntityCount: 64, maxEntitySize: 4096 } });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new UploadError(400, `This .svg is not well-formed XML: ${why}`);
  }
  if (!/^<svg[\s>/]/.test(afterProlog(text))) {
    throw new UploadError(400, 'This .svg does not start with an <svg> element.');
  }
}

/**
 * Accepts only png, jpg/jpeg, pdf, eps and svg up to 20 MB whose content matches the extension
 * (SPEC 4.2). Throws an UploadError naming what is wrong.
 */
export function checkUpload(path: string, bytes: Uint8Array): void {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (!path.includes('.') || !(UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new UploadError(
      400,
      `Only ${UPLOAD_EXTENSIONS.join(', ')} files can be uploaded, not "${path.slice(path.lastIndexOf('/') + 1)}".`,
    );
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    const mb = (bytes.byteLength / 1024 / 1024).toFixed(1);
    throw new UploadError(413, `The file is ${mb} MB; uploads are limited to 20 MB.`);
  }
  if (bytes.byteLength === 0) throw new UploadError(400, 'The file is empty.');

  const matches: Record<string, () => boolean> = {
    png: () => startsWith(bytes, PNG),
    jpg: () => startsWith(bytes, JPEG),
    jpeg: () => startsWith(bytes, JPEG),
    pdf: () => startsWith(bytes, PDF),
    eps: () => startsWith(bytes, POSTSCRIPT) || startsWith(bytes, DOS_EPS),
  };
  if (ext === 'svg') return checkSvg(bytes);
  if (!matches[ext]?.()) {
    throw new UploadError(400, `The file's contents are not a valid .${ext} file.`);
  }
}
