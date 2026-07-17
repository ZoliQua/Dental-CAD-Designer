// packages/kernel/src/halfedge/validate.ts
//
// `assertValidTopology(hm)`: full structural invariant check for a
// `HalfedgeMesh` — per this task's brief (item 2) and CLAUDE.md's "Geometry
// work" rule: "Halfedge topology: run assertValidTopology() in tests and
// debug builds after any structural edit."
//
// ## Scope
//
// This checks the STRUCTURAL invariants of the typed-array halfedge encoding
// itself (twin involution, next 3-cycles, vertex/face consistency, no
// dangling references) — every one of these holds for ANY mesh
// `buildHalfedge` successfully returns, INCLUDING one with a bowtie vertex
// (`findNonManifoldVertices`, build.ts). Deliberately NOT checked here:
// one-ring "completeness" (whether circulating from a vertex's anchor
// reaches every one of its outgoing halfedges) — that is exactly the
// property a bowtie vertex breaks, and this task's brief scopes bowtie
// FIXING to Task 11 while leaving bowtie MESHES buildable (buildHalfedge
// only rejects non-manifold EDGES, not vertices — see build.ts's doc).
// Baking a one-ring-completeness check into this general-purpose assertion
// would make it fail on every bowtie mesh regardless of whether the caller
// cares about that vertex at all; `findNonManifoldVertices` is the right,
// separately-callable tool for that question. (The property test suite
// separately checks one-ring iteration against a brute-force oracle on
// bowtie-free generated meshes — see halfedge.property.test.ts — so
// iterate.ts's circulators are still verified correct where they're
// expected to be complete.)
import type { HalfedgeMesh } from './types.ts';

function fail(message: string): never {
  throw new Error(`assertValidTopology: ${message}`);
}

/**
 * Throws a descriptive `Error` on the first invariant violation found (not a
 * boolean return — a broken halfedge structure is always a bug, never an
 * expected outcome to branch on, so throwing matches this kernel's other
 * hard-invariant checks, e.g. boolean/manifold.ts's `NonManifoldInputError`
 * path). Checks, in order:
 *
 * 1. Array-length consistency (every array sized exactly as `hm`'s counts
 *    say it should be).
 * 2. Every stored index is in-range (`twin` in `[-1, halfedgeCount)`, `next`
 *    in `[0, halfedgeCount)`, `vertex` in `[0, vertexCount)`, `face` in
 *    `[0, faceCount)`, `vertexHalfedge` in `[-1, halfedgeCount)`).
 * 3. Fixed triangle grouping: `face[he] === floor(he / 3)` for every `he`
 *    (catches any corruption of the structural invariant types.ts's
 *    "Layout" doc describes).
 * 4. `next` 3-cycles: `next[next[next[he]]] === he` and every halfedge in
 *    the cycle shares the same `face`.
 * 5. `twin` involution: `twin[he] === -1` or `twin[twin[he]] === he`, never
 *    self-twinned, twin belongs to a DIFFERENT face, and the twin pair's
 *    edge endpoints match in both directions (`vertex[twin[he]] ===
 *    vertex[next[he]]` and `vertex[next[twin[he]]] === vertex[he]`).
 * 6. Vertex consistency: `vertexHalfedge[v] !== -1` implies
 *    `vertex[vertexHalfedge[v]] === v`.
 * 7. No dangling: every vertex referenced as some halfedge's origin has a
 *    non `-1` `vertexHalfedge` anchor.
 */
export function assertValidTopology(hm: HalfedgeMesh): void {
  const { vertexCount, faceCount, halfedgeCount, twin, next, vertex, face, vertexHalfedge } = hm;

  if (halfedgeCount !== faceCount * 3)
    fail(`halfedgeCount ${halfedgeCount} !== faceCount * 3 (${faceCount * 3})`);
  for (const [name, arr] of [
    ['twin', twin],
    ['next', next],
    ['vertex', vertex],
    ['face', face],
  ] as const) {
    if (arr.length !== halfedgeCount)
      fail(`${name}.length ${arr.length} !== halfedgeCount ${halfedgeCount}`);
  }
  if (vertexHalfedge.length !== vertexCount) {
    fail(`vertexHalfedge.length ${vertexHalfedge.length} !== vertexCount ${vertexCount}`);
  }

  for (let he = 0; he < halfedgeCount; he++) {
    const t = twin[he]!;
    if (t < -1 || t >= halfedgeCount)
      fail(`twin[${he}] = ${t} out of range [-1, ${halfedgeCount})`);
    const n = next[he]!;
    if (n < 0 || n >= halfedgeCount) fail(`next[${he}] = ${n} out of range [0, ${halfedgeCount})`);
    const v = vertex[he]!;
    if (v < 0 || v >= vertexCount) fail(`vertex[${he}] = ${v} out of range [0, ${vertexCount})`);
    const f = face[he]!;
    if (f < 0 || f >= faceCount) fail(`face[${he}] = ${f} out of range [0, ${faceCount})`);
    if (f !== Math.floor(he / 3))
      fail(`face[${he}] = ${f} !== expected fixed-triangle-grouping face ${Math.floor(he / 3)}`);
  }
  for (let v = 0; v < vertexCount; v++) {
    const anchor = vertexHalfedge[v]!;
    if (anchor < -1 || anchor >= halfedgeCount)
      fail(`vertexHalfedge[${v}] = ${anchor} out of range [-1, ${halfedgeCount})`);
  }

  // next 3-cycles + same-face.
  for (let he = 0; he < halfedgeCount; he++) {
    const n1 = next[he]!;
    const n2 = next[n1]!;
    const n3 = next[n2]!;
    if (n3 !== he)
      fail(`next-cycle broken at halfedge ${he}: next(next(next(${he}))) = ${n3} !== ${he}`);
    if (face[n1]! !== face[he]! || face[n2]! !== face[he]!) {
      fail(
        `next-cycle at halfedge ${he} does not stay within one face (face[${he}]=${face[he]}, face[${n1}]=${face[n1]}, face[${n2}]=${face[n2]})`,
      );
    }
  }

  // twin involution + edge endpoint symmetry.
  for (let he = 0; he < halfedgeCount; he++) {
    const t = twin[he]!;
    if (t === -1) continue;
    if (t === he) fail(`halfedge ${he} is its own twin`);
    if (twin[t]! !== he) fail(`twin involution broken: twin[${he}]=${t} but twin[${t}]=${twin[t]}`);
    if (face[t]! === face[he]!)
      fail(`halfedge ${he} and its twin ${t} belong to the same face ${face[he]}`);
    const heFrom = vertex[he]!;
    const heTo = vertex[next[he]!]!;
    const tFrom = vertex[t]!;
    const tTo = vertex[next[t]!]!;
    if (tFrom !== heTo || tTo !== heFrom) {
      fail(
        `twin edge endpoints mismatch: halfedge ${he} goes ${heFrom}->${heTo}, twin ${t} goes ${tFrom}->${tTo} ` +
          `(expected ${heTo}->${heFrom})`,
      );
    }
  }

  // vertex consistency + no dangling.
  const referenced = new Uint8Array(vertexCount);
  for (let he = 0; he < halfedgeCount; he++) referenced[vertex[he]!] = 1;
  for (let v = 0; v < vertexCount; v++) {
    const anchor = vertexHalfedge[v]!;
    if (anchor === -1) {
      if (referenced[v])
        fail(`vertex ${v} is referenced by a halfedge but has no vertexHalfedge anchor (dangling)`);
      continue;
    }
    if (vertex[anchor]! !== v)
      fail(
        `vertexHalfedge[${v}] = ${anchor} but vertex[${anchor}] = ${vertex[anchor]} (expected ${v})`,
      );
  }
}

/** Env var gating `debugAssertValidTopology` below — see this module's
 * top-of-file doc / CLAUDE.md's "Halfedge topology" rule ("gated into
 * debug builds (env/dev flag, documented)"). Guarded with a `typeof
 * process !== 'undefined'` check because `packages/kernel` is reachable
 * from BOTH Node (kernel-workers' Node worker entry) and a bundled browser
 * Web Worker (kernel-workers' browser entry) — `process` does not exist in
 * the latter unless a bundler shims it, so this always safely resolves to
 * "disabled" there rather than throwing a ReferenceError. */
const DEBUG_ENV_VAR = 'DQCAD_KERNEL_DEBUG_ASSERTIONS';

export function halfedgeDebugAssertionsEnabled(): boolean {
  return typeof process !== 'undefined' && process.env?.[DEBUG_ENV_VAR] === '1';
}

/**
 * Runs `assertValidTopology` only when `DQCAD_KERNEL_DEBUG_ASSERTIONS=1` is
 * set in the environment — the "debug builds" half of CLAUDE.md's "run
 * assertValidTopology() in tests and debug builds after any structural
 * edit" rule (this task's brief's item 2). Intended for future halfedge-
 * MUTATING operations (e.g. Task 11's bowtie splitting) to call after every
 * structural edit without paying `assertValidTopology`'s O(halfedgeCount)
 * cost in production by default. Tests should call `assertValidTopology`
 * directly (unconditionally) — see halfedge.property.test.ts and every
 * other test in this directory — not this gated wrapper, so a broken
 * invariant always fails CI regardless of environment.
 */
export function debugAssertValidTopology(hm: HalfedgeMesh): void {
  if (halfedgeDebugAssertionsEnabled()) assertValidTopology(hm);
}
