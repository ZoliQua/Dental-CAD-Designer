// scripts/bridge-journal-lib.ts
//
// Phase 6 Task 9 — the ASSEMBLED 3-unit bridge pipeline + its journal-
// reproducibility harness (THE PHASE GATE). The bridge analogue of
// scripts/crown-journal-lib.ts (P4 T12) and scripts/cavity-journal-lib.ts
// (P5 T10): ONE source of truth for test/golden/bridge-journal-acceptance.test.ts,
// so the complete-bridge acceptance AND the record→replay→bit-identical proof are
// written once, for BOTH mode chains (full-contour + framework).
//
// ## What this assembles — the GENUINELY COUPLED bridge chain (the P4-T12b lesson)
//
// The full fixed-order bridge-design stages run end-to-end on the closed-form
// 3-unit posterior bridge (two shoulder-prep abutment units flanking a pontic,
// the SAME kernel primitives the T6 `bridgeAssemblyFixture` is built from —
// `closedShellUnit` + the connector loft ops + a capped-cylinder die; no slow SDF).
// Each stage produces a CONTENT-ADDRESSED output the caller journals. NO decoupled
// stand-ins: the per-abutment intaglio surfaces the QC re-measures ARE inside the
// unit solids the assembly fuses; the cut-back unit surfaces the QC thickness gate
// measures in framework mode ARE the ones the assembly fused; the connectors the
// area gate judges ARE the ones assembled; the pontic base whose relief is measured
// IS the base recorded in the pontic op.
//
//   The chain (6 content-addressed ops), per mode:
//     1. bridge.abutmentSurfaces — the two abutment intaglio (fit) surfaces, built
//        against the SHARED insertion axis (the closed-form abutment fit surfaces —
//        the P6 closed-form standin, same spirit as the crown-standin barrel; the
//        SDF `runBridgeAbutmentSurfacesStage` is exercised in T2). outputHashes =
//        [inner14, inner16].
//     2. bridge.ponticInterface — the placed pontic BODY + the T3 `shapePonticBase`
//        gingival interface base (a REAL analytic offset), whose relief is measured
//        by the T3 `measurePonticRelief` instrument on a fine ridge (fed to the QC
//        ponticRelief gate). outputHashes = [ponticBody, ponticBase].
//     3. bridge.connectors — the two ruled-loft connector bars, overlapping the
//        proximal walls so the union fuses (the T4 loft + fail-safe area ops).
//        outputHashes = [connA, connB].
//     4. bridge.framework — `runBridgeFrameworkStage` (the T5 stage, the MODE
//        VARIANT). full-contour: a byte-identical pass-through (outputHashes ==
//        the unit hashes). framework: each unit's OUTER anatomy cut back inward by
//        the veneering space, fit + margin byte-exact (outputHashes = the cut-back
//        unit hashes). The mode is a JOURNALED design decision inside the chain.
//     5. bridge.assembly — `runBridgeAssemblyStage` (the T6 stage): the framework
//        unit meshes + the connectors fused into ONE watertight single-component
//        solid via the manifold-3d union. outputHashes = [assembledSolid].
//     6. bridge.qc — `runBridgeQc` (the T6/T8 whole-bridge gate set) on the
//        assembled solid, mode-aware thresholds. outputHashes = [hashQcReport].
//
// ## Journal reproducibility (CLAUDE.md invariants 2/3 — the phase-gate crux)
//
// `recordBridgeJournal(mode)` runs the chain once, sealing each stage's content-
// addressed output (the mesh content hash; for QC a hash of the QcReport JSON).
// `replayBridgeJournal` re-runs the ENTIRE coupled chain FRESH (cold caches) and
// re-hashes, asserting bit-identity. The analytic intaglios + the analytic pontic
// base + the lofts + the pure-Float64 cutback + the WASM union + the 11-gate QC are
// all deterministic (no Math.random, no Date.now, no worker scheduling), so replay
// reproduces every stage hash byte-for-byte. If it does NOT, that is a real
// determinism leak to FIND and FIX — never a comparison to loosen.
import { createHash } from 'node:crypto';
import {
  analyzeMesh,
  buildBvh,
  computePseudonormals,
  shapePonticBase,
  measurePonticRelief,
  buildConnectorFrame,
  loftConnectorProfiles,
  makeEllipseConnectorProfile,
  measureConnectorMinArea,
  orientNormalsConsistently,
  KERNEL_VERSION,
  type IndexedMesh,
  type Vec3,
  type FitRegionDescriptor,
  type RidgeCrestCylinder,
  type PonticBaseFootprint,
  type PonticBaseResolution,
  type PonticInterfaceStyle,
} from '@dqcad/kernel';
import type { FdiTooth, Operation, QcReport } from '@dqcad/shared-types';
import {
  runBridgeFrameworkStage,
  runBridgeAssemblyStage,
  runBridgeQc,
  measureMarginFit,
  connectorPositionalTargetMm2,
  type ConnectorCrossSection,
  type BridgeUnitQcInput,
  type BridgePipelineContext,
  type PipelineMaterialProfile,
  type PipelineMeshHandle,
  type BridgeFrameworkStageResult,
  type BridgeAssemblyStageResult,
} from '@dqcad/cad-pipeline';
import { closedShellUnit, submeshFromTriRange } from '../packages/kernel/src/bridge/frameworkCutback.test-fixtures.ts';
import { bridgeFixture } from '../packages/kernel/src/bridge/bridge.test-fixtures.ts';

// ---------------------------------------------------------------------------
// Canonical hashing — byte-for-byte the client's `hashMeshContent` /
// apps/server's `hashMesh`: sha256(positions LE bytes ‖ indices LE bytes). Same
// function scripts/crown-journal-lib.ts + scripts/cavity-journal-lib.ts use.
// ---------------------------------------------------------------------------
export function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

/** Deterministic hash of a QcReport (the QC stage's content-addressed output —
 * no timestamp, so its JSON is hash-stable). Same as the crown/cavity libs. */
export function hashQcReport(report: QcReport): string {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

function handle(contentHash: string, mesh: IndexedMesh): PipelineMeshHandle {
  return { contentHash, mesh };
}

// ---------------------------------------------------------------------------
// Fixed clinical/geometry constants — the SAME zirconia bridge profile the T6
// bridge-acceptance golden uses (the live-UI default), assembled not duplicated.
// Determinism: no random, no Date.now.
// ---------------------------------------------------------------------------
export const AXIS: Vec3 = [0, 0, 1];
export const ABUTMENT_TEETH = [14, 16] as FdiTooth[];
export const PONTIC_TOOTH = 15 as FdiTooth;
const UNIT_TEETH = [14, 15, 16] as FdiTooth[];
const UNIT_LABELS = ['14', '15', '16'];
const UNIT_KINDS: ('abutment' | 'pontic')[] = ['abutment', 'pontic', 'abutment'];
export const UNIT_ADJACENCY: readonly (readonly [FdiTooth, FdiTooth])[] = [
  [14, 15],
  [15, 16],
] as unknown as readonly (readonly [FdiTooth, FdiTooth])[];

// Closed-form unit geometry (mm) — mirrors `bridgeAssemblyFixture`'s defaults.
const R = 3; // outer radius
const r = 1; // cavity radius (⇒ 2.0 mm axial wall full-contour)
const H = 4; // outer height
const h = 2; // cavity height
const SEG = 32; // ring segments
const SPAN = 7; // centre-to-centre span
// Connector OVERLAP is deeper than the T6 fixture's 0.5 mm so the connector ends
// stay INSIDE the cut-back walls (radius R−veneering = 2 in framework mode) — the
// framework chain fuses genuinely (not a full-contour stand-in), while still
// clearing the cavity (end radial R−overlap = 1.5 > r = 1). Documented.
const OVERLAP = 1.5;
const CONN_Z = 2.2; // connector centre z (occlusal to the margin)
const DIE_FRAC = 0.85; // die radius / cavity radius (clearance)
const VENEERING_MM = 1.0; // framework cutback depth (profile field)
const TAPER_BAND_MM = 0.2; // framework taper band (= the marginExclusion feather)

/** The zirconia bridge material profile (thresholds the stages + gates read). */
export const PROFILE: PipelineMaterialProfile = {
  id: 'standard-zirconia',
  version: '1.4.0',
  restorationParams: {
    cementGapMm: 0.05,
    marginalGapMm: 0.02,
    spacerStartMm: 0.8,
    minWallThicknessMm: 0.5,
    proximalContactPenetrationMm: 0.02,
    occlusalContactMm: 0,
  },
  connectorAreaMm2: { posteriorMm2: 9, anteriorMm2: 7 },
  undercutBlockoutThresholdMm: 0,
  occlusalMinWallThicknessMm: 0.5,
  maxChordDeviationMm: 0.005,
  inlayMinThicknessMm: 0.5,
  onlayMinThicknessMm: 0.5,
  cuspCoverageMinThicknessMm: 0.7,
  marginExclusionMm: TAPER_BAND_MM,
  inlayMarginExclusionMm: 1.3,
  onlayMarginExclusionMm: 1.8,
  frameworkMinThicknessMm: 0.5,
  ponticHygienicClearanceMm: 2.0,
  ponticRidgeLapReliefMm: 0.05,
  ponticOvateDepthMm: 1.0,
  veneeringSpaceMm: VENEERING_MM,
};

// The T3 pontic-relief instrument constants — the fine ridge the T6 golden uses.
const RIDGE = { ridgeCrestRadiusMm: 3, ridgeCrestCenterZMm: 1, ridgeHalfLengthMm: 5, ridgeCrestSegments: 160, ridgeStations: 16 } as const;
const FOOTPRINT: PonticBaseFootprint = { stationMinMm: -4, stationMaxMm: 4, angularHalfSpanRad: (60 * Math.PI) / 180 };
const RES: PonticBaseResolution = { meshStations: 24, meshAngularSegments: 48, sampleStations: 40, sampleAngularSegments: 80 };
function fixtureCrest(): RidgeCrestCylinder {
  return { axisPointMm: [0, 0, RIDGE.ridgeCrestCenterZMm], mesialDistalDir: [1, 0, 0], buccalDir: [0, 1, 0], upDir: [0, 0, 1], radiusMm: RIDGE.ridgeCrestRadiusMm };
}
/** The configured relief for a style (from the profile — never hardcoded). */
export function configuredReliefForStyle(style: PonticInterfaceStyle): number {
  if (style === 'hygienic') return PROFILE.ponticHygienicClearanceMm;
  if (style === 'ridgeLap') return PROFILE.ponticRidgeLapReliefMm;
  return PROFILE.ponticOvateDepthMm;
}
/** Shape a pontic base for `style` at `builtAtMm` and measure its relief vs the
 * `configuredMm` target — the T3 acceptance measurable (worst |measured−configured|
 * on the primary patch). `builtAtMm !== configuredMm` is the mis-configured probe. */
export interface ReliefMeasurement {
  readonly style: PonticInterfaceStyle;
  readonly configuredMm: number;
  readonly baseMesh: IndexedMesh;
  readonly maxAbsDeviationMm: number;
  readonly minDeviationMm: number;
  readonly meanDeviationMm: number;
  readonly errorBoundMm: number;
}
export function measureStyleRelief(style: PonticInterfaceStyle, builtAtMm?: number): ReliefMeasurement {
  const configuredMm = configuredReliefForStyle(style);
  const built = builtAtMm ?? configuredMm;
  const crest = fixtureCrest();
  const gingiva = bridgeFixture(RIDGE).ridge.mesh;
  const bvh = buildBvh(gingiva);
  const pn = computePseudonormals(gingiva);
  const params = style === 'hygienic' ? { clearanceMm: built } : style === 'ridgeLap' ? { reliefMm: built } : { depthMm: built };
  const shaped = shapePonticBase(crest, style, params, FOOTPRINT, RES);
  // Judge the built base against the CONFIGURED target (retarget samples if the
  // base was deliberately built at a different value — the falsifiable probe).
  const samples = built === configuredMm ? [...shaped.samples] : shaped.samples.map((s) => ({ ...s, targetMm: style === 'ovate' ? -configuredMm : configuredMm }));
  const relief = measurePonticRelief(gingiva, bvh, pn, samples, crest);
  return {
    style,
    configuredMm,
    baseMesh: shaped.mesh,
    maxAbsDeviationMm: relief.primary.maxAbsDeviationMm,
    minDeviationMm: relief.primary.minDeviationMm,
    meanDeviationMm: relief.primary.meanDeviationMm,
    errorBoundMm: shaped.errorBoundMm,
  };
}

// ---------------------------------------------------------------------------
// Closed-form geometry builders (mirror bridgeAssemblyFixture — the SAME kernel
// primitives, extended with the tri-range submesh extraction + the correct outer
// vs inner margin loops the coupled cutback chain needs).
// ---------------------------------------------------------------------------
function translateX(mesh: IndexedMesh, dx: number): IndexedMesh {
  const positions = new Float64Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    positions[i] = mesh.positions[i]! + dx;
    positions[i + 1] = mesh.positions[i + 1]!;
    positions[i + 2] = mesh.positions[i + 2]!;
  }
  return { positions, indices: mesh.indices.slice() };
}
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
    tris.push(bottom[s]!, bottom[s1]!, top[s1]!, bottom[s]!, top[s1]!, top[s]!);
    tris.push(cb, bottom[s1]!, bottom[s]!);
    tris.push(ct, top[s]!, top[s1]!);
  }
  return orientNormalsConsistently({ positions: new Float64Array(positions), indices: new Uint32Array(tris) }).mesh;
}
function buildConnectorBar(cxA: number, cxB: number, semiAxisMm: number, connSeg: number): { mesh: IndexedMesh; minAreaMm2: number } {
  const startX = cxA + R - OVERLAP;
  const endX = cxB - R + OVERLAP;
  const spanMm = endX - startX;
  const frame = buildConnectorFrame([startX, 0, CONN_Z], [1, 0, 0], spanMm);
  const profileA = makeEllipseConnectorProfile(semiAxisMm, semiAxisMm, connSeg);
  const profileB = makeEllipseConnectorProfile(semiAxisMm, semiAxisMm, connSeg);
  const mesh = loftConnectorProfiles(profileA, profileB, frame).mesh;
  const minAreaMm2 = measureConnectorMinArea(mesh, frame, profileA, profileB).minAreaMm2;
  return { mesh, minAreaMm2 };
}

// ---------------------------------------------------------------------------
// Variants + the assembled result.
// ---------------------------------------------------------------------------
export type BridgeMode = 'fullContour' | 'framework';
/** `full`/`framework` — the two recorded acceptance chains; `connector5` — the
 * falsifiable 5 mm² posterior-connector block (full-contour geometry). */
export type BridgeVariant = 'full' | 'framework' | 'connector5';

const VARIANT_MODE: Record<BridgeVariant, BridgeMode> = { full: 'fullContour', framework: 'framework', connector5: 'fullContour' };
const CONNECTOR_SEMI: Record<BridgeVariant, number> = { full: 1.9, framework: 1.9, connector5: 1.2633 };

export interface AssembledBridge {
  readonly variant: BridgeVariant;
  readonly mode: BridgeMode;
  /** The per-abutment intaglio (fit) surfaces (14, 16) — content-addressed. */
  readonly abutmentInnerHashes: readonly string[];
  /** The pontic body + shaped gingival base — content-addressed. */
  readonly ponticBodyHash: string;
  readonly ponticBaseHash: string;
  /** The two connector meshes — content-addressed. */
  readonly connectorHashes: readonly string[];
  /** The framework stage result (mode variant) — one journaled op. */
  readonly framework: BridgeFrameworkStageResult;
  /** The assembly stage result — one journaled op. */
  readonly assembly: BridgeAssemblyStageResult;
  readonly qcReport: QcReport;
  /** The connector-area gate inputs (the T4 measured min areas). */
  readonly connectors: readonly ConnectorCrossSection[];
  /** Measured acceptance numbers (RE-MEASURED in the assembled chain). */
  readonly measured: {
    readonly assembledWatertight: boolean;
    readonly assembledComponentCount: number;
    readonly assembledTriCount: number;
    readonly connectorMinAreaMm2: number;
    readonly connectorThresholdMm2: number;
    readonly perUnitMinWallMm: Record<string, number>;
    readonly minWallThresholdMm: number;
    /** Per-abutment margin fit BEFORE the union (pre-union intaglio submesh). */
    readonly perAbutmentFitBeforeMm: Record<string, number>;
    /** Per-abutment margin fit AFTER the union (gate value on the assembled solid). */
    readonly perAbutmentFitAfterMm: Record<string, number>;
    readonly ponticReliefMm: number;
    readonly ponticReliefThresholdMm: number;
    readonly seatingValueMm3: number;
    readonly seatingThresholdMm3: number;
    readonly maxAppliedCutbackMm: number;
    readonly reportPassed: boolean;
  };
}

// Memoize the assembled case per variant (the WASM union + QC are the slow part)
// so the acceptance + reproducibility suites share it WITHIN a run. Value-level
// cache only; record/replay reset it to prove a cold build reproduces the pins.
const caseCache = new Map<BridgeVariant, AssembledBridge>();

function unitFitRegion(cx: number): FitRegionDescriptor {
  return { axisPointMm: [cx, 0, 0], axis: [0, 0, 1], maxRadialMm: r + 0.1, minAxialMm: -0.05, maxAxialMm: h + 0.05 };
}

function bridgeContext(): BridgePipelineContext {
  return {
    restorationId: 'bridge-accept',
    restorationType: 'bridge',
    materialProfile: PROFILE,
    insertionAxis: AXIS,
    targetMesh: handle('bridge-arch', cappedCylinder(0, 0.01, 0.02, 3)), // unused by framework/assembly stages
    marginLoops: {},
    neighbors: {},
    antagonist: null,
    ponticSites: [PONTIC_TOOTH],
    gingivaMesh: null,
    unitAdjacency: UNIT_ADJACENCY,
    stages: {},
  };
}

/**
 * Runs the full assembled bridge chain for `variant` and returns every stage
 * result + the RE-MEASURED acceptance numbers. Deterministic (fixed params, no
 * random / Date.now). GENUINELY COUPLED end-to-end.
 */
export async function assembleBridgeCase(variant: BridgeVariant): Promise<AssembledBridge> {
  const cached = caseCache.get(variant);
  if (cached) return cached;

  const mode = VARIANT_MODE[variant];
  const ctx = bridgeContext();
  const shell = closedShellUnit({ outerRadiusMm: R, innerRadiusMm: r, outerHeightMm: H, innerHeightMm: h, segments: SEG });
  const [oS, oE] = shell.outerTriRange;
  const [iS, iE] = shell.innerTriRange;
  const centres = [-SPAN, 0, SPAN];

  // --- 1/2/3: the closed-form unit blanks, per-unit margin loops, and the pontic
  //     interface base. The abutment intaglios (inner submeshes) are the content-
  //     addressed abutmentSurfaces outputs; the pontic body + base the pontic op's;
  //     the lofts the connectors op's.
  interface UnitBuild {
    readonly cx: number;
    readonly label: string;
    readonly kind: 'abutment' | 'pontic';
    readonly tooth: FdiTooth;
    readonly blank: IndexedMesh; // pre-framework unit solid
    readonly outerMargin: Vec3[]; // the OUTER finish-line ring (cutback taper locus)
    readonly innerMargin: Vec3[]; // the INNER cavity rim (marginFit currency)
    readonly die: IndexedMesh | null;
  }
  const unitBuilds: UnitBuild[] = centres.map((cx, i) => {
    const blank = translateX(shell.mesh, cx);
    const outerMargin: Vec3[] = shell.marginLoop.map((p) => [p[0] + cx, p[1], p[2]]);
    const innerRing0 = shell.innerWallRingIndices[0]!;
    const innerMargin: Vec3[] = innerRing0.map((vi) => [shell.mesh.positions[vi * 3]! + cx, shell.mesh.positions[vi * 3 + 1]!, shell.mesh.positions[vi * 3 + 2]!]);
    const die = UNIT_KINDS[i] === 'abutment' ? cappedCylinder(cx, r * DIE_FRAC, h, SEG) : null;
    return { cx, label: UNIT_LABELS[i]!, kind: UNIT_KINDS[i]!, tooth: UNIT_TEETH[i]!, blank, outerMargin, innerMargin, die };
  });

  // abutment intaglio (fit) surfaces — extracted from the closed-form unit blanks.
  const abutmentInnerHashes: string[] = unitBuilds.filter((u) => u.kind === 'abutment').map((u) => hashMesh(submeshFromTriRange(u.blank, iS, iE)));

  // pontic body (the placed closed-form body) + the T3 gingival base (hygienic).
  const ponticBuild = unitBuilds[1]!; // the middle unit is the pontic
  const ponticBodyHash = hashMesh(ponticBuild.blank);
  const hygienic = measureStyleRelief('hygienic');
  const ponticBaseHash = hashMesh(hygienic.baseMesh);

  // connectors — the two ruled-loft bars overlapping the proximal walls.
  const semi = CONNECTOR_SEMI[variant];
  const connA = buildConnectorBar(-SPAN, 0, semi, 48);
  const connB = buildConnectorBar(0, SPAN, semi, 48);
  const connectorHashes = [hashMesh(connA.mesh), hashMesh(connB.mesh)];
  const connectors: ConnectorCrossSection[] = [
    { label: '14–15', minAreaMm2: connA.minAreaMm2, teeth: [14, 15] as [FdiTooth, FdiTooth], targetMm2: connectorPositionalTargetMm2(14 as FdiTooth, 15 as FdiTooth, PROFILE.connectorAreaMm2) },
    { label: '15–16', minAreaMm2: connB.minAreaMm2, teeth: [15, 16] as [FdiTooth, FdiTooth], targetMm2: connectorPositionalTargetMm2(15 as FdiTooth, 16 as FdiTooth, PROFILE.connectorAreaMm2) },
  ];

  // --- 4: framework stage (the MODE VARIANT) — full-contour pass-through OR the
  //     per-unit cutback. Its output unit meshes are what the assembly fuses.
  const framework = runBridgeFrameworkStage(ctx, {
    mode,
    units: unitBuilds.map((u) => ({
      tooth: u.tooth,
      mesh: u.blank,
      meshContentHash: hashMesh(u.blank),
      fitVertexMask: shell.fitVertexMask,
      marginLoop: u.outerMargin,
    })),
    marginTaperBandMm: TAPER_BAND_MM,
    hashMesh,
  });
  const frameworkUnits = framework.units; // in unitBuilds order

  // --- 5: assembly stage — fuse the framework unit meshes + the connectors.
  const assembly = await runBridgeAssemblyStage(ctx, {
    unitMeshes: frameworkUnits.map((u) => handle(u.meshContentHash, u.mesh)),
    connectorMeshes: [handle(connectorHashes[0]!, connA.mesh), handle(connectorHashes[1]!, connB.mesh)],
    hashMesh,
  });

  // --- 6: whole-bridge QC on the assembled solid (mode-aware thresholds). The
  //     unit inner/outer surfaces are extracted from the SAME framework unit meshes
  //     the assembly fused (genuine coupling — no stand-ins).
  const qcUnits: BridgeUnitQcInput[] = unitBuilds.map((u, i) => {
    const fUnit = frameworkUnits[i]!;
    return {
      label: u.label,
      kind: u.kind,
      innerSurfaceMesh: submeshFromTriRange(fUnit.mesh, iS, iE),
      outerSurfaceMesh: submeshFromTriRange(fUnit.mesh, oS, oE),
      insertionAxis: AXIS,
      marginLoop: u.innerMargin,
      fitRegion: u.kind === 'abutment' ? unitFitRegion(u.cx) : undefined,
    };
  });
  const qcReport = await runBridgeQc({
    assembledSolid: assembly.assembledSolid,
    units: qcUnits,
    dieSolids: unitBuilds.filter((u) => u.die).map((u) => u.die!),
    connectors,
    minWallThicknessMm: PROFILE.restorationParams.minWallThicknessMm,
    occlusalMinWallThicknessMm: PROFILE.occlusalMinWallThicknessMm,
    connectorAreaTargetMm2: PROFILE.connectorAreaMm2.posteriorMm2,
    frameworkMode: mode === 'framework',
    frameworkMinThicknessMm: PROFILE.frameworkMinThicknessMm,
    ponticRelief: { maxAbsDeviationMm: hygienic.maxAbsDeviationMm, style: 'hygienic', configuredReliefMm: hygienic.configuredMm },
    kernelVersion: KERNEL_VERSION,
    profileVersion: PROFILE.version,
    journalHash: `bridge-accept-${variant}`,
  });

  const byGate = Object.fromEntries(qcReport.gates.map((g) => [g.gate, g]));
  const perUnitMinWallMm: Record<string, number> = {};
  for (const u of unitBuilds) perUnitMinWallMm[u.label] = byGate[`minWallThickness:${u.label}`]!.value ?? Number.POSITIVE_INFINITY;
  const perAbutmentFitBeforeMm: Record<string, number> = {};
  const perAbutmentFitAfterMm: Record<string, number> = {};
  for (const u of unitBuilds) {
    if (u.kind !== 'abutment') continue;
    perAbutmentFitBeforeMm[u.label] = measureMarginFit(submeshFromTriRange(u.blank, iS, iE), u.innerMargin).maxMm;
    perAbutmentFitAfterMm[u.label] = byGate[`marginFit:${u.label}`]!.value ?? Number.POSITIVE_INFINITY;
  }
  const connectorGate = byGate['connectorCrossSection']!;
  const relief = byGate['ponticRelief']!;
  const seating = byGate['seating']!;

  const result: AssembledBridge = {
    variant,
    mode,
    abutmentInnerHashes,
    ponticBodyHash,
    ponticBaseHash,
    connectorHashes,
    framework,
    assembly,
    qcReport,
    connectors,
    measured: {
      assembledWatertight: analyzeMesh(assembly.assembledSolid).watertight,
      assembledComponentCount: assembly.componentCount,
      assembledTriCount: assembly.triangleCount,
      connectorMinAreaMm2: connectorGate.value ?? Number.POSITIVE_INFINITY,
      connectorThresholdMm2: connectorGate.threshold ?? 0,
      perUnitMinWallMm,
      minWallThresholdMm: byGate['minWallThickness:14']!.threshold ?? 0,
      perAbutmentFitBeforeMm,
      perAbutmentFitAfterMm,
      ponticReliefMm: relief.value ?? Number.POSITIVE_INFINITY,
      ponticReliefThresholdMm: relief.threshold ?? 0,
      seatingValueMm3: seating.value ?? Number.POSITIVE_INFINITY,
      seatingThresholdMm3: seating.threshold ?? 0,
      maxAppliedCutbackMm: framework.units.reduce((m, u) => Math.max(m, u.maxAppliedCutbackMm), 0),
      reportPassed: qcReport.passed,
    },
  };
  caseCache.set(variant, result);
  return result;
}

// ---------------------------------------------------------------------------
// Journal reproducibility — record the 6 stage ops (content-addressed), then
// replay every stage FRESH and assert bit-identity.
// ---------------------------------------------------------------------------
export interface BridgeReplayFailure {
  readonly stage: string;
  readonly expectedHash: string;
  readonly actualHash: string;
}

export interface RecordedBridgeJournal {
  readonly mode: BridgeMode;
  readonly variant: BridgeVariant;
  /** One Operation per stage, content-addressed. */
  readonly operations: readonly Operation[];
  /** The assembled bridge (for the caller to report measured numbers). */
  readonly bridge: AssembledBridge;
}

const FIXED_TIMESTAMP = new Date(0).toISOString(); // audit-display only; keeps the recorded journal byte-deterministic.

/** The content-addressed op id for a (mode, stage) — one per (chain, stage). */
export function bridgeStageId(mode: BridgeMode, stage: string): string {
  return `bridge-${mode}-${stage}`;
}

function buildOperations(bridge: AssembledBridge): Operation[] {
  const m = bridge.mode;
  const ops: Operation[] = [];
  ops.push({
    id: bridgeStageId(m, 'abutmentSurfaces'),
    name: 'bridge.abutmentSurfaces',
    params: { abutmentTeeth: ABUTMENT_TEETH as unknown as number[], sharedInsertionAxis: AXIS },
    inputHashes: [bridge.assembly.inputHashes[0] ?? 'arch'],
    outputHashes: [...bridge.abutmentInnerHashes],
    kernelVersion: KERNEL_VERSION,
    timestamp: FIXED_TIMESTAMP,
  });
  ops.push({
    id: bridgeStageId(m, 'ponticInterface'),
    name: 'bridge.ponticInterface',
    params: { ponticTooth: PONTIC_TOOTH as unknown as number, style: 'hygienic', configuredReliefMm: PROFILE.ponticHygienicClearanceMm },
    inputHashes: [bridge.ponticBodyHash],
    outputHashes: [bridge.ponticBodyHash, bridge.ponticBaseHash],
    kernelVersion: KERNEL_VERSION,
    timestamp: FIXED_TIMESTAMP,
  });
  ops.push({
    id: bridgeStageId(m, 'connectors'),
    name: 'bridge.connectors',
    params: { pairs: UNIT_ADJACENCY as unknown as number[][], minAreaMm2: bridge.connectors.map((c) => c.minAreaMm2) },
    inputHashes: [...bridge.abutmentInnerHashes],
    outputHashes: [...bridge.connectorHashes],
    kernelVersion: KERNEL_VERSION,
    timestamp: FIXED_TIMESTAMP,
  });
  ops.push({
    id: bridgeStageId(m, 'framework'),
    name: bridge.framework.operationName,
    params: bridge.framework.params,
    inputHashes: bridge.framework.inputHashes,
    outputHashes: bridge.framework.outputHashes,
    kernelVersion: KERNEL_VERSION,
    timestamp: FIXED_TIMESTAMP,
  });
  ops.push({
    id: bridgeStageId(m, 'assembly'),
    name: bridge.assembly.operationName,
    params: bridge.assembly.params,
    inputHashes: bridge.assembly.inputHashes,
    outputHashes: bridge.assembly.outputHashes,
    kernelVersion: KERNEL_VERSION,
    timestamp: FIXED_TIMESTAMP,
  });
  ops.push({
    id: bridgeStageId(m, 'qc'),
    name: 'qc.run',
    params: { gateCount: bridge.qcReport.gates.length, passed: bridge.qcReport.passed, mode: m },
    inputHashes: [bridge.assembly.contentHash],
    outputHashes: [hashQcReport(bridge.qcReport)],
    kernelVersion: KERNEL_VERSION,
    timestamp: FIXED_TIMESTAMP,
  });
  return ops;
}

/** Maps an assembled bridge to its stage→outputHash record (the replay currency).
 * A stage with multiple outputs is joined (order-stable) so a per-stage compare
 * catches a drift in ANY of its outputs. */
function actualHashes(bridge: AssembledBridge): Record<string, string> {
  const m = bridge.mode;
  return {
    [bridgeStageId(m, 'abutmentSurfaces')]: bridge.abutmentInnerHashes.join('|'),
    [bridgeStageId(m, 'ponticInterface')]: [bridge.ponticBodyHash, bridge.ponticBaseHash].join('|'),
    [bridgeStageId(m, 'connectors')]: bridge.connectorHashes.join('|'),
    [bridgeStageId(m, 'framework')]: bridge.framework.outputHashes.join('|'),
    [bridgeStageId(m, 'assembly')]: bridge.assembly.contentHash,
    [bridgeStageId(m, 'qc')]: hashQcReport(bridge.qcReport),
  };
}

const VARIANT_FOR_MODE: Record<BridgeMode, BridgeVariant> = { fullContour: 'full', framework: 'framework' };

/** Records the assembled bridge journal for `mode` — every stage with a
 * content-addressed output hash. */
export async function recordBridgeJournal(mode: BridgeMode): Promise<RecordedBridgeJournal> {
  const variant = VARIANT_FOR_MODE[mode];
  const bridge = await assembleBridgeCase(variant);
  return { mode, variant, operations: buildOperations(bridge), bridge };
}

/**
 * Replays the recorded journal FRESH from scratch — re-runs the ENTIRE coupled
 * chain (`assembleBridgeCase`, cold: the caller resets the caches first) as an
 * independent computation and re-hashes every stage output, comparing against the
 * recorded `outputHashes`. Returns every stage whose replay is NOT bit-identical
 * (empty ⇒ full reproducibility). Re-running the whole assembler (rather than a
 * hand-duplicated chain) guarantees the replay path cannot silently drift.
 */
export async function replayBridgeJournal(journal: RecordedBridgeJournal): Promise<BridgeReplayFailure[]> {
  const expected: Record<string, string> = {};
  for (const op of journal.operations) expected[op.id] = op.outputHashes.join('|');
  const bridge = await assembleBridgeCase(journal.variant);
  const actual = actualHashes(bridge);
  const failures: BridgeReplayFailure[] = [];
  for (const [id, expectedHash] of Object.entries(expected)) {
    const actualHash = actual[id]!;
    if (actualHash !== expectedHash) failures.push({ stage: id, expectedHash, actualHash });
  }
  return failures;
}

/** Reset the module-level case cache — for tests that must prove a build from a
 * truly cold start reproduces the recorded hashes. */
export function resetBridgeCaches(): void {
  caseCache.clear();
}
