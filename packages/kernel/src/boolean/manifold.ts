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
// manifoldSmoke job (packages/kernel-workers/src/jobs/misc.ts) imports
// '@dqcad/kernel', and worker-entry.node.ts loads jobs/registry.ts directly through
// Node's own loader (no bundler in between) inside a worker_threads worker.
// Node's native TS type-stripping resolves relative specifiers by their
// literal extension — it does NOT map a `.js` specifier to a sibling `.ts`
// file the way a bundler does (verified empirically) — so every relative
// import reachable from that native-load path must spell out `.ts`. See
// packages/kernel-workers/tsconfig.json's allowImportingTsExtensions
// comment for the same requirement on that package.
import Module from 'manifold-3d';
import type { ErrorStatus, Manifold, ManifoldToplevel, Mat4, Mesh } from 'manifold-3d';
import type { IndexedMesh } from '../mesh/types.ts';
import { normalizePlane, type Plane, type PlaneBasis } from '../section/plane.ts';

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

// ---------------------------------------------------------------------------
// sectionCap (Task 10): filled cross-section polygon, via manifold-3d's
// `Manifold.slice()`, for closed watertight meshes. This is the DISPLAY-ONLY
// half of Task 10's cross-section feature — the acceptance-critical outline
// polyline (../section/polyline.ts's `sectionMesh`) never touches
// manifold-3d and is exact Float64 end-to-end; this function inherits
// manifold-3d's Float32 WASM-boundary rounding (see `toManifoldMesh`'s
// `@errorBound` above) THROUGH THE ROTATION as well (the rotation below is
// applied to the ALREADY-Float32-cast vertex positions manifold-3d holds
// internally), so a cap vertex can be off the true section plane by up to
// the same ~1.2e-7 relative / ~1.2e-4 mm absolute bound documented there —
// acceptable for a visual fill, never used for any measurement.
// ---------------------------------------------------------------------------

/**
 * Builds the column-major `Mat4` (see manifold-3d's `Manifold.transform`
 * doc: "last row is ignored", i.e. this is really a 3x4 affine transform
 * with no translation here) that maps a world-space point `p` to
 * `(e1.p, e2.p, normal.p)` — `basis`'s local frame, with `basis.normal`
 * landing on manifold-3d's slice axis (+Z). No translation component: the
 * plane's actual offset along `normal` is handled by `slice`'s `height`
 * argument (`basis.d`) instead, not by translating the manifold first — see
 * `sectionCap`'s call site.
 */
function rotationMat4FromBasis(basis: PlaneBasis): Mat4 {
  const { e1, e2, normal } = basis;
  return [
    e1[0], e2[0], normal[0], 0,
    e1[1], e2[1], normal[1], 0,
    e1[2], e2[2], normal[2], 0,
    0, 0, 0, 1,
  ];
}

/**
 * Filled cross-section polygon(s) where `plane` cuts `mesh`, triangulated
 * into a flat `IndexedMesh` in WORLD coordinates — `null` if the plane
 * misses the mesh entirely (manifold-3d's `slice` returns an empty
 * `CrossSection` in that case; see `Manifold.slice`'s doc). Only valid for
 * CLOSED WATERTIGHT meshes (this task's brief) — like `union`/`subtract`/
 * `intersect` above, rejects a non-watertight `mesh` with
 * {@link NonManifoldInputError} rather than silently producing a nonsense
 * cap.
 *
 * Multiple disjoint contours (e.g. a plane cutting a torus through its
 * center, or a hole in the cross-section) are handled automatically —
 * `CrossSection.toPolygons()`/manifold-3d's own `triangulate()` already
 * resolve the fill rule (which loops are outer boundaries vs. holes), so
 * this function never needs to reason about winding/containment itself.
 */
export async function sectionCap(mesh: IndexedMesh, plane: Plane): Promise<IndexedMesh | null> {
  const basis = normalizePlane(plane); // throws DegeneratePlaneError before touching WASM at all
  const toplevel = await initManifold();
  const manifold = constructManifold(toplevel, mesh); // throws NonManifoldInputError if not watertight
  try {
    const rotated = manifold.transform(rotationMat4FromBasis(basis));
    try {
      const cross = rotated.slice(basis.d);
      try {
        if (cross.isEmpty()) {
          return null;
        }
        const polygons = cross.toPolygons();
        const triangles = toplevel.triangulate(polygons);
        if (triangles.length === 0) {
          return null;
        }

        // Flatten `polygons` once, in the SAME order fed to `triangulate` —
        // its returned triangle-vertex indices reference this exact
        // concatenation ("referencing the original polygon points in
        // order" — manifold-3d's `triangulate` doc).
        const flat2d: [number, number][] = [];
        for (const contour of polygons) {
          for (const point of contour) {
            flat2d.push(point);
          }
        }

        const positions = new Float64Array(flat2d.length * 3);
        for (let i = 0; i < flat2d.length; i++) {
          const [u, v] = flat2d[i]!;
          // Inverse of plane.ts's projectToPlaneXY — see PlaneBasis's doc:
          // p = u*e1 + v*e2 + d*normal.
          positions[i * 3] = u * basis.e1[0] + v * basis.e2[0] + basis.d * basis.normal[0];
          positions[i * 3 + 1] = u * basis.e1[1] + v * basis.e2[1] + basis.d * basis.normal[1];
          positions[i * 3 + 2] = u * basis.e1[2] + v * basis.e2[2] + basis.d * basis.normal[2];
        }
        const indices = new Uint32Array(triangles.length * 3);
        for (let i = 0; i < triangles.length; i++) {
          const [a, b, c] = triangles[i]!;
          indices[i * 3] = a;
          indices[i * 3 + 1] = b;
          indices[i * 3 + 2] = c;
        }
        return { positions, indices };
      } finally {
        cross.delete();
      }
    } finally {
      rotated.delete();
    }
  } finally {
    manifold.delete();
  }
}
