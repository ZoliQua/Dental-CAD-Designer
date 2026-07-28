// packages/kernel/src/bridge/bridgeAssembly.test-fixtures.ts
//
// Phase 6 Task 6 — the closed-form 3-UNIT BRIDGE ASSEMBLY fixture: three closed
// "shell unit" solids (two abutments flanking a pontic) placed along the arch (X),
// plus two connector bars that OVERLAP the adjacent units' proximal walls, plus a
// prep die per abutment (for the seating simulation). Everything is analytic,
// deterministic, Float64, and parameterized so the acceptance table AND the three
// falsifiable blocks (5 mm² connector / thin unit / disjoint connector) are all
// driven from ONE builder.
//
// Not exported from packages/kernel/src/index.ts (the *.test-fixtures.ts
// convention). Reuses `closedShellUnit` (the Task-5 unit) so the fit / margin /
// outer partition is analytically known per unit.
//
// ## Geometry (mm)
//
//   Units are `closedShellUnit`s (outer wall+dome radius R, cavity radius r,
//   outer height H, cavity height h), placed at X-centres -span, 0, +span:
//   mesial (abutment) — pontic — distal (abutment). Adjacent outer walls do NOT
//   overlap (span > R + gap), but each CONNECTOR is a straight ruled loft whose
//   ends penetrate ~`overlapMm` INTO the two units' proximal walls (radial 2.5→3
//   region), occlusal to (above) the cervical margin (z=0) — so a boolean UNION
//   genuinely fuses all five solids into one, and the intaglio pockets + margin
//   rims (radial < r, near z=0) stay untouched by the fuse.
//
//   The die per abutment is a capped cylinder radius `r·dieClearanceFraction`
//   (< r), z∈[0,h], on the unit axis — it sits INSIDE the cavity pocket with
//   clearance, so `assembledSolid ∩ die` is empty (zero seating interference).
//
// ## Falsifiable knobs
//   • `connectorSemiAxisMm` — the ellipse radius of BOTH connectors (healthy
//     ~11 mm² default; set for ~5 mm² to drive the connector-area BLOCK).
//   • `thinUnitInnerRadiusMm` — override the pontic cavity radius so its wall
//     (R − r) drops below the thickness minimum (the thin-unit BLOCK).
//   • `disjointConnectorA` — float connector A far in +Z so it touches nothing
//     (the disjoint-union BLOCK — `assembleBridge` throws `BridgeAssemblyError`).
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { closedShellUnit, submeshFromTriRange, type ClosedShellUnit } from './frameworkCutback.test-fixtures.ts';
import { buildConnectorFrame, loftConnectorProfiles, makeEllipseConnectorProfile, measureConnectorMinArea } from './connector.ts';
import type { FitRegionDescriptor } from './bridgeAssembly.ts';
import { orientNormalsConsistently } from '../intake/orient.ts';

/** Translate a mesh by (dx,0,0) — a pure X translation (topology + winding
 * preserved; triangle ranges stay valid). */
function translateX(mesh: IndexedMesh, dx: number): IndexedMesh {
  const positions = new Float64Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    positions[i] = mesh.positions[i]! + dx;
    positions[i + 1] = mesh.positions[i + 1]!;
    positions[i + 2] = mesh.positions[i + 2]!;
  }
  return { positions, indices: mesh.indices.slice() };
}

/** A closed capped cylinder (radius rad, z∈[0,height]) centred at (cx,0), for the
 * seating die. Watertight, outward-wound. */
function cappedCylinder(cx: number, rad: number, height: number, segments: number): IndexedMesh {
  const positions: number[] = [];
  const pushV = (x: number, y: number, z: number): number => {
    const i = positions.length / 3;
    positions.push(x, y, z);
    return i;
  };
  const bottom: number[] = [];
  const top: number[] = [];
  for (let s = 0; s < segments; s++) {
    const th = (2 * Math.PI * s) / segments;
    bottom.push(pushV(cx + rad * Math.cos(th), rad * Math.sin(th), 0));
    top.push(pushV(cx + rad * Math.cos(th), rad * Math.sin(th), height));
  }
  const cb = pushV(cx, 0, 0);
  const ct = pushV(cx, 0, height);
  const tris: number[] = [];
  for (let s = 0; s < segments; s++) {
    const s1 = (s + 1) % segments;
    // side quad
    tris.push(bottom[s]!, bottom[s1]!, top[s1]!, bottom[s]!, top[s1]!, top[s]!);
    // caps
    tris.push(cb, bottom[s1]!, bottom[s]!);
    tris.push(ct, top[s]!, top[s1]!);
  }
  const raw: IndexedMesh = { positions: new Float64Array(positions), indices: new Uint32Array(tris) };
  return orientNormalsConsistently(raw).mesh;
}

export interface BridgeAssemblyUnit {
  /** FDI-ish label for this unit (14 mesial abutment, pontic, 16 distal abutment). */
  readonly label: string;
  /** Whether this unit is an abutment (has margin fit + a die) or the pontic. */
  readonly kind: 'abutment' | 'pontic';
  /** The placed closed unit solid (a union input). */
  readonly mesh: IndexedMesh;
  /** The placed intaglio (fit) surface submesh — the min-wall inner surface. */
  readonly innerSurfaceMesh: IndexedMesh;
  /** The placed outer-anatomy surface submesh — the min-wall outer surface. */
  readonly outerSurfaceMesh: IndexedMesh;
  /** The placed cavity-margin ring (dense polyline) — the marginFit currency. */
  readonly marginLoop: Vec3[];
  /** The intaglio fit-region descriptor for `extractFitPatch` on the assembled
   * solid (construction provenance — the unit's known cavity bounds). */
  readonly fitRegion: FitRegionDescriptor;
  /** Per-vertex fit mask (the T5 cutback provenance) for THIS placed unit. */
  readonly fitVertexMask: boolean[];
  /** The unit's insertion axis (world) — [0,0,1] for these untilted units. */
  readonly insertionAxis: Vec3;
  /** The abutment prep die (capped cylinder inside the cavity) — abutments only. */
  readonly die: IndexedMesh | null;
  /** The unit centre X (mm). */
  readonly centreXMm: number;
}

export interface BridgeAssemblyFixture {
  readonly units: readonly BridgeAssemblyUnit[];
  /** The two connector bars (mesial↔pontic, pontic↔distal) — union inputs, each
   * with its REAL measured minimum cross-section area (the T4 gate value). */
  readonly connectors: readonly { readonly label: string; readonly mesh: IndexedMesh; readonly teeth: readonly [number, number]; readonly minAreaMm2: number }[];
  /** All solids to fuse (units + connectors), in a deterministic order. */
  readonly solids: readonly IndexedMesh[];
  readonly params: {
    readonly R: number;
    readonly r: number;
    readonly H: number;
    readonly h: number;
    readonly spanMm: number;
    readonly segments: number;
    readonly connectorSemiAxisMm: number;
    readonly connectorSegments: number;
  };
}

export interface BridgeAssemblyFixtureOptions {
  /** Unit outer radius R (mm). Default 3. */
  readonly outerRadiusMm?: number;
  /** Unit cavity radius r (mm). Default 1. */
  readonly innerRadiusMm?: number;
  /** Unit outer height H (mm). Default 4. */
  readonly outerHeightMm?: number;
  /** Unit cavity height h (mm). Default 2. */
  readonly innerHeightMm?: number;
  /** Ring segments per unit. Default 32. */
  readonly segments?: number;
  /** Centre-to-centre span (mm) between adjacent units. Default 7. */
  readonly spanMm?: number;
  /** Connector ellipse radius (mm) — BOTH connectors. Default 1.9 (~11 mm²).
   * Set ~1.263 for a ~5 mm² connector (the area BLOCK). */
  readonly connectorSemiAxisMm?: number;
  /** Connector profile segments. Default 48. */
  readonly connectorSegments?: number;
  /** Connector centre Z (mm) — occlusal to the margin. Default 2.2. */
  readonly connectorCentreZMm?: number;
  /** How far (mm) each connector end penetrates into a unit wall. Default 0.5. */
  readonly overlapMm?: number;
  /** Die radius as a fraction of the cavity radius r. Default 0.85 (clearance). */
  readonly dieClearanceFraction?: number;
  /** Override the PONTIC cavity radius (mm) — set close to R for a thin wall (the
   * thickness BLOCK). Default: same as `innerRadiusMm`. */
  readonly thinPonticInnerRadiusMm?: number;
  /** Float connector A in +Z so it touches nothing (the disjoint-union BLOCK). */
  readonly disjointConnectorA?: boolean;
}

function buildUnit(
  label: string,
  kind: 'abutment' | 'pontic',
  centreX: number,
  shell: ClosedShellUnit,
  R: number,
  r: number,
  h: number,
  dieClearanceFraction: number,
  dieSegments: number,
): BridgeAssemblyUnit {
  const mesh = translateX(shell.mesh, centreX);
  const [oStart, oEnd] = shell.outerTriRange;
  const [iStart, iEnd] = shell.innerTriRange;
  const outerSurfaceMesh = submeshFromTriRange(mesh, oStart, oEnd);
  const innerSurfaceMesh = submeshFromTriRange(mesh, iStart, iEnd);
  // The cavity margin ring = the inner wall ring at z=0 (the intaglio's open rim).
  const innerRing0 = shell.innerWallRingIndices[0]!;
  const marginLoop: Vec3[] = innerRing0.map((vi) => [
    shell.mesh.positions[vi * 3]! + centreX,
    shell.mesh.positions[vi * 3 + 1]!,
    shell.mesh.positions[vi * 3 + 2]!,
  ]);
  const fitRegion: FitRegionDescriptor = {
    axisPointMm: [centreX, 0, 0],
    axis: [0, 0, 1],
    maxRadialMm: r + 0.1,
    minAxialMm: -0.05,
    maxAxialMm: h + 0.05,
  };
  const die = kind === 'abutment' ? cappedCylinder(centreX, r * dieClearanceFraction, h, dieSegments) : null;
  return {
    label,
    kind,
    mesh,
    innerSurfaceMesh,
    outerSurfaceMesh,
    marginLoop,
    fitRegion,
    fitVertexMask: shell.fitVertexMask,
    insertionAxis: [0, 0, 1],
    die,
    centreXMm: centreX,
  };
}

/** Build one connector bar between two unit centres, penetrating `overlapMm` into
 * each unit's proximal wall. `floatZ` (if given) lifts it clear of everything. */
function buildConnector(
  cxA: number,
  cxB: number,
  R: number,
  semiAxisMm: number,
  segments: number,
  centreZ: number,
  overlapMm: number,
  floatZ: number | null,
): { mesh: IndexedMesh; minAreaMm2: number } {
  // Proximal wall X of unit A (right side) = cxA + R; of unit B (left) = cxB − R.
  const startX = cxA + R - overlapMm; // inside unit A
  const endX = cxB - R + overlapMm; // inside unit B
  const spanMm = endX - startX;
  const z = floatZ ?? centreZ;
  const origin: Vec3 = [startX, 0, z];
  const frame = buildConnectorFrame(origin, [1, 0, 0], spanMm);
  const profileA = makeEllipseConnectorProfile(semiAxisMm, semiAxisMm, segments);
  const profileB = makeEllipseConnectorProfile(semiAxisMm, semiAxisMm, segments);
  const mesh = loftConnectorProfiles(profileA, profileB, frame).mesh;
  // The REAL T4 fail-safe min cross-section area on the loft (the gate value).
  const minAreaMm2 = measureConnectorMinArea(mesh, frame, profileA, profileB).minAreaMm2;
  return { mesh, minAreaMm2 };
}

/** The analytic 3-unit bridge assembly fixture — see this module's doc. */
export function bridgeAssemblyFixture(options: BridgeAssemblyFixtureOptions = {}): BridgeAssemblyFixture {
  const R = options.outerRadiusMm ?? 3;
  const r = options.innerRadiusMm ?? 1;
  const H = options.outerHeightMm ?? 4;
  const h = options.innerHeightMm ?? 2;
  const segments = options.segments ?? 32;
  const spanMm = options.spanMm ?? 7;
  const connectorSemiAxisMm = options.connectorSemiAxisMm ?? 1.9;
  const connectorSegments = options.connectorSegments ?? 48;
  const connectorCentreZMm = options.connectorCentreZMm ?? 2.2;
  const overlapMm = options.overlapMm ?? 0.5;
  const dieClearanceFraction = options.dieClearanceFraction ?? 0.85;
  const ponticR = options.thinPonticInnerRadiusMm ?? r;

  const abutmentShell = closedShellUnit({ outerRadiusMm: R, innerRadiusMm: r, outerHeightMm: H, innerHeightMm: h, segments });
  const ponticShell = closedShellUnit({ outerRadiusMm: R, innerRadiusMm: ponticR, outerHeightMm: H, innerHeightMm: h, segments });

  const mesial = buildUnit('14', 'abutment', -spanMm, abutmentShell, R, r, h, dieClearanceFraction, segments);
  const pontic = buildUnit('15', 'pontic', 0, ponticShell, R, ponticR, h, dieClearanceFraction, segments);
  const distal = buildUnit('16', 'abutment', spanMm, abutmentShell, R, r, h, dieClearanceFraction, segments);

  const connA = buildConnector(-spanMm, 0, R, connectorSemiAxisMm, connectorSegments, connectorCentreZMm, overlapMm, options.disjointConnectorA ? 40 : null);
  const connB = buildConnector(0, spanMm, R, connectorSemiAxisMm, connectorSegments, connectorCentreZMm, overlapMm, null);

  const units = [mesial, pontic, distal];
  const connectors = [
    { label: '14–15', mesh: connA.mesh, teeth: [14, 15] as const, minAreaMm2: connA.minAreaMm2 },
    { label: '15–16', mesh: connB.mesh, teeth: [15, 16] as const, minAreaMm2: connB.minAreaMm2 },
  ];
  const solids = [mesial.mesh, pontic.mesh, distal.mesh, connA.mesh, connB.mesh];

  return {
    units,
    connectors,
    solids,
    params: { R, r, H, h, spanMm, segments, connectorSemiAxisMm, connectorSegments },
  };
}
