// Wraps manifold-3d (the WASM boolean/CSG geometry kernel) behind the
// kernel's Float64 IndexedMesh type. Scope is deliberately narrow (YAGNI,
// see docs/plans/phase-0-foundation.md): union/subtract/intersect plus the
// volume/surfaceArea measurements tests and later QC gates need. No other
// manifold-3d surface (offsets, smoothing, SDFs, hulls, ...) is wired up
// here until a later phase actually needs it.
//
// `.ts`-extension relative imports (not this repo's usual `.js` suffix,
// contrast packages/shared-types): this module is reachable via NATIVE Node
// module resolution, not just bundler/vitest resolution — kernel-workers'
// manifoldSmoke job (packages/kernel-workers/src/jobs.ts) imports
// '@dqcad/kernel', and worker-entry.node.ts loads jobs.ts directly through
// Node's own loader (no bundler in between) inside a worker_threads worker.
// Node's native TS type-stripping resolves relative specifiers by their
// literal extension — it does NOT map a `.js` specifier to a sibling `.ts`
// file the way a bundler does (verified empirically) — so every relative
// import reachable from that native-load path must spell out `.ts`. See
// packages/kernel-workers/tsconfig.json's allowImportingTsExtensions
// comment for the same requirement on that package.
import Module from 'manifold-3d';
import type { ErrorStatus, Manifold, ManifoldToplevel, Mesh } from 'manifold-3d';
import type { IndexedMesh } from '../mesh/types.ts';

// manifold-3d's Mesh only ever carries our three position channels here —
// no normals, UVs, or other vertex properties (YAGNI, see module doc above).
const POSITION_NUM_PROP = 3;

/** Every status manifold-3d's Manifold constructor can report (see
 * manifold-3d's ErrorStatus type) — used to validate the untyped `code`
 * field on a thrown construction error before trusting it as an
 * `ErrorStatus`. */
const ERROR_STATUSES: ReadonlySet<ErrorStatus> = new Set<ErrorStatus>([
  'NoError',
  'NonFiniteVertex',
  'NotManifold',
  'VertexOutOfBounds',
  'PropertiesWrongLength',
  'MissingPositionProperties',
  'MergeVectorsDifferentLengths',
  'MergeIndexOutOfBounds',
  'TransformWrongLength',
  'RunIndexWrongLength',
  'FaceIDWrongLength',
  'InvalidConstruction',
  'ResultTooLarge',
  'InvalidTangents',
  'Cancelled',
]);

function isErrorStatus(value: unknown): value is ErrorStatus {
  return typeof value === 'string' && ERROR_STATUSES.has(value as ErrorStatus);
}

/**
 * Thrown when constructing a manifold-3d `Manifold` from an `IndexedMesh`
 * fails manifold-3d's structural validation — most commonly a non-watertight
 * (open) mesh, reported as `status === 'NotManifold'`, but this also
 * surfaces any other non-'NoError' construction status manifold-3d reports
 * (e.g. non-finite vertices) under the same typed error so callers have one
 * thing to catch for "this mesh was not valid input".
 */
export class NonManifoldInputError extends Error {
  /** The specific manifold-3d ErrorStatus that caused construction to fail. */
  readonly status: ErrorStatus;

  constructor(status: ErrorStatus, message?: string) {
    super(message ?? `manifold-3d rejected mesh input: ${status}`);
    this.name = 'NonManifoldInputError';
    this.status = status;
  }
}

function toNonManifoldInputError(error: unknown): NonManifoldInputError {
  const code = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  const status = isErrorStatus(code) ? code : 'InvalidConstruction';
  const message = error instanceof Error ? error.message : undefined;
  return new NonManifoldInputError(status, message);
}

let manifoldPromise: Promise<ManifoldToplevel> | null = null;

/**
 * Lazily instantiates the manifold-3d WASM module exactly once per
 * thread/worker, memoizing the in-flight promise so concurrent callers on
 * the same thread share one instantiation instead of racing separate
 * `Module()` calls. Safe to call from Node (worker_threads worker or main
 * thread) or a browser Web Worker — manifold-3d's Emscripten glue detects
 * the environment itself.
 */
export function initManifold(): Promise<ManifoldToplevel> {
  manifoldPromise ??= Module().then((toplevel) => {
    toplevel.setup();
    return toplevel;
  });
  return manifoldPromise;
}

/**
 * Converts a kernel {@link IndexedMesh} (Float64 positions) into manifold-3d's
 * `Mesh` (Float32 vertProperties) — the input side of manifold-3d's WASM
 * boundary.
 *
 * @errorBound This is the ONE documented Float64→Float32 exception in the
 * kernel (docs/plans/phase-0-foundation.md Global Constraints: "the
 * manifold-3d WASM boundary converts Float64→Float32; the wrapper documents
 * this as an error bound"). Casting a Float64 coordinate to Float32 rounds
 * it to Float32's ~7 significant decimal digits (machine epsilon
 * 2^-23 ≈ 1.19e-7), bounding the RELATIVE error introduced by this cast to
 * ~1.2e-7. At the mm scale used throughout this kernel, that is at most
 * ~1.2e-4 mm of absolute error for a 1000 mm coordinate (comfortably inside
 * dental/CAD working volumes). This rounding happens once, going in;
 * {@link fromManifoldMesh} widens Float32 back to Float64 exactly (every
 * Float32 value is exactly representable in Float64), so no further error
 * is introduced on the way out.
 */
function toManifoldMesh(toplevel: ManifoldToplevel, mesh: IndexedMesh): Mesh {
  return new toplevel.Mesh({
    numProp: POSITION_NUM_PROP,
    vertProperties: new Float32Array(mesh.positions),
    triVerts: new Uint32Array(mesh.indices),
  });
}

/**
 * Converts a manifold-3d `Mesh` (Float32 vertProperties) back into the
 * kernel's Float64 {@link IndexedMesh} — the output side of manifold-3d's
 * WASM boundary.
 *
 * @errorBound See {@link toManifoldMesh}'s `@errorBound`: the Float64→Float32
 * rounding for this boundary is fully accounted for there. Float32→Float64
 * widening here is exact and adds no additional error.
 */
function fromManifoldMesh(mesh: Mesh): IndexedMesh {
  if (mesh.numProp !== POSITION_NUM_PROP) {
    // Can only happen if a future change starts requesting extra vertex
    // channels (normals, UVs, ...) from manifold-3d — this wrapper only
    // ever asks for positions (see POSITION_NUM_PROP), so every mesh it
    // produces or consumes has exactly 3 properties per vertex.
    throw new Error(
      `manifold.ts: expected a position-only mesh (numProp === ${POSITION_NUM_PROP}), got numProp === ${mesh.numProp}`,
    );
  }
  return {
    positions: new Float64Array(mesh.vertProperties),
    indices: new Uint32Array(mesh.triVerts),
  };
}

/**
 * Constructs a manifold-3d `Manifold` from an `IndexedMesh`, surfacing a
 * construction failure (most commonly a non-watertight mesh) as a typed
 * {@link NonManifoldInputError} instead of manifold-3d's internal error
 * shape.
 */
function constructManifold(toplevel: ManifoldToplevel, mesh: IndexedMesh): Manifold {
  const manifoldMesh = toManifoldMesh(toplevel, mesh);
  try {
    return new toplevel.Manifold(manifoldMesh);
  } catch (error) {
    throw toNonManifoldInputError(error);
  }
}

/** Runs `fn` against a Manifold built from `mesh`, always freeing the
 * Manifold's WASM memory afterwards (Manifold instances are not
 * garbage-collected — see manifold-3d's `Manifold.delete()` docs). */
async function withManifold<T>(mesh: IndexedMesh, fn: (manifold: Manifold) => T): Promise<T> {
  const toplevel = await initManifold();
  const manifold = constructManifold(toplevel, mesh);
  try {
    return fn(manifold);
  } finally {
    manifold.delete();
  }
}

/** Runs a binary boolean op (`op`) against Manifolds built from `a` and `b`,
 * converts the result back to an `IndexedMesh`, and frees every WASM-side
 * Manifold created along the way (the two inputs and the result). */
async function runBooleanOp(
  a: IndexedMesh,
  b: IndexedMesh,
  op: (manifoldA: Manifold, manifoldB: Manifold) => Manifold,
): Promise<IndexedMesh> {
  const toplevel = await initManifold();
  const manifoldA = constructManifold(toplevel, a);
  const manifoldB = constructManifold(toplevel, b);
  try {
    const result = op(manifoldA, manifoldB);
    try {
      return fromManifoldMesh(result.getMesh());
    } finally {
      result.delete();
    }
  } finally {
    manifoldA.delete();
    manifoldB.delete();
  }
}

/** Boolean union (A ∪ B) of two indexed meshes. Both inputs must be
 * watertight (2-manifold) or this rejects with {@link NonManifoldInputError}. */
export async function union(a: IndexedMesh, b: IndexedMesh): Promise<IndexedMesh> {
  return runBooleanOp(a, b, (manifoldA, manifoldB) => manifoldA.add(manifoldB));
}

/** Boolean difference (A − B) of two indexed meshes. Both inputs must be
 * watertight (2-manifold) or this rejects with {@link NonManifoldInputError}. */
export async function subtract(a: IndexedMesh, b: IndexedMesh): Promise<IndexedMesh> {
  return runBooleanOp(a, b, (manifoldA, manifoldB) => manifoldA.subtract(manifoldB));
}

/** Boolean intersection (A ∩ B) of two indexed meshes. Both inputs must be
 * watertight (2-manifold) or this rejects with {@link NonManifoldInputError}. */
export async function intersect(a: IndexedMesh, b: IndexedMesh): Promise<IndexedMesh> {
  return runBooleanOp(a, b, (manifoldA, manifoldB) => manifoldA.intersect(manifoldB));
}

/** Volume of a watertight mesh, in mm³ (mesh coordinates are mm — see
 * Global Constraints). Rejects with {@link NonManifoldInputError} if `mesh`
 * is not watertight. */
export async function volume(mesh: IndexedMesh): Promise<number> {
  return withManifold(mesh, (manifold) => manifold.volume());
}

/** Surface area of a watertight mesh, in mm². Rejects with
 * {@link NonManifoldInputError} if `mesh` is not watertight. */
export async function surfaceArea(mesh: IndexedMesh): Promise<number> {
  return withManifold(mesh, (manifold) => manifold.surfaceArea());
}
