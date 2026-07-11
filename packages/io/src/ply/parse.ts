// packages/io/src/ply/parse.ts
//
// Top-level PLY entry point: parses the header (header.ts), builds the
// read plan (plan.ts), pushes header comments into diagnostics, and
// dispatches to whichever of the three body readers `header.format`
// names (ascii.ts, or binary.ts with `littleEndian` true/false).

import type { ParseDiagnostics, ParseFormat } from '../types.ts';
import { parsePlyAsciiBody } from './ascii.ts';
import { parsePlyBinaryBody } from './binary.ts';
import { parsePlyHeader } from './header.ts';
import { planPlyHeader } from './plan.ts';
import type { PlyFormat, PlyMesh } from './types.ts';

function toParseFormat(format: PlyFormat): ParseFormat {
  switch (format) {
    case 'ascii':
      return 'ply-ascii';
    case 'binary_little_endian':
      return 'ply-binary-le';
    case 'binary_big_endian':
      return 'ply-binary-be';
  }
}

/**
 * Parses `bytes` as a PLY file (any of the three body formats,
 * auto-detected from the header's own `format` line — PLY, unlike STL,
 * always states its format explicitly, so there is no sniffing/detection
 * heuristic to write here). Returns a `PlyMesh` whose `diagnostics` field
 * carries the detected format, header comments, and every non-fatal
 * observation made while reading (unrecognized elements/properties,
 * fan-triangulated non-triangular faces — see plan.ts / binary.ts /
 * ascii.ts for what gets recorded and why).
 */
export function parsePly(bytes: Uint8Array): PlyMesh {
  const { header, bodyOffset } = parsePlyHeader(bytes);

  const diagnostics: ParseDiagnostics = {
    warnings: [],
    format: toParseFormat(header.format),
  };

  // Comment/obj_info lines are collected into diagnostics per this
  // package's brief — pushed as warnings (this package's one "non-fatal
  // observations" bucket, see ../types.ts's ParseDiagnostics doc) with a
  // keyword-tagged prefix so callers can distinguish them from genuine
  // problems (e.g. by filtering out entries starting with "comment:" /
  // "obj_info:") without this package needing a second diagnostics field
  // that STL's ParseDiagnostics shape doesn't share.
  for (const comment of header.comments) {
    diagnostics.warnings.push(`${comment.keyword}: ${comment.text}`);
  }

  const plan = planPlyHeader(header, diagnostics);

  switch (header.format) {
    case 'ascii':
      return parsePlyAsciiBody(bytes, header, plan, bodyOffset, diagnostics);
    case 'binary_little_endian':
      return parsePlyBinaryBody(bytes, header, plan, bodyOffset, true, diagnostics);
    case 'binary_big_endian':
      return parsePlyBinaryBody(bytes, header, plan, bodyOffset, false, diagnostics);
  }
}
