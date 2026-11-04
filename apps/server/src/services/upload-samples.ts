// Minimal valid bytes for each upload type, shared by service and route tests.

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(
    parts.flatMap((p) => (typeof p === 'string' ? [...new TextEncoder().encode(p)] : p)),
  );

export const SAMPLES = {
  png: bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'rest'),
  jpg: bytes([0xff, 0xd8, 0xff, 0xe0], 'rest'),
  pdf: bytes('%PDF-1.7\n%…'),
  eps: bytes('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n'),
  dosEps: bytes([0xc5, 0xd0, 0xd3, 0xc6], 'rest'),
  svg: bytes('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>'),
};

export { bytes };
