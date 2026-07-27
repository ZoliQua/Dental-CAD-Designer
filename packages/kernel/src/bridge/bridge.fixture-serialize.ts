// packages/kernel/src/bridge/bridge.fixture-serialize.ts
//
// TEST-ONLY canonical serializer for the CLIENT-side 3-unit bridge fixture asset
// (Phase 6 Task 7) — the single definition of the byte format of
// `apps/client/src/engine/bridgeFixture.asset.json`, consumed by the browser-lane
// dom test (apps/client/src/ui/BridgeDesignPanel.dom.test.tsx) through
// engine/bridgeGeometry.ts's loader.
//
// ## Why this exists (the P5-T8 drift-guard contract, bridge edition)
//
// The browser-lane dom test drives the whole bridge critical path (abutment
// surfaces → pontic → connectors → framework → assembly → QC) on the analytic
// 3-unit fixture, but the layer rule bars apps/client from importing kernel test
// CODE. So the client consumes a committed DATA asset generated from the
// kernel's OWN `bridgeAssemblyFixture` output (+ the T3 pontic-relief
// measurements + the T4 connector frames), and
// `bridge.fixture-asset.test.ts` regenerates this serialization on every kernel
// test run and compares it byte-for-byte against the committed asset — so ANY
// change to the fixture geometry FAILS the kernel suite until the asset is
// deliberately regenerated:
//
//   npx tsx scripts/generate-client-bridge-fixture.ts
//
// Both the generator script and the guard test call THIS function, so the
// asset's canonical byte form has exactly one definition. Not exported from the
// kernel index (the *.test-fixtures.ts / fixture-serialize convention).
//
// ## What the asset carries (and why)
//
// The client drives three REGISTERED jobs live — `bridgeConnectors` (the connector
// editor: re-loft + measure editable profiles), `bridgeAssembly` (fuse), and
// `runBridgeQc` (whole-bridge QC) — so the asset carries every INPUT those jobs
// need: the placed unit solids + their inner/outer/margin/fitRegion/die submeshes
// (from `bridgeAssemblyFixture`), the connector FRAMES + default profiles (derived
// from the same fixture params as the fixture's own connectors, so a default
// re-loft reproduces them byte-for-byte), and the T3 pontic-relief MEASUREMENTS
// per style (the ±20 µm acceptance evidence — measured here by the real kernel
// instrument, never re-derived client-side). The upstream abutment-surface /
// pontic-body geometry is asset-provided (the kernel-built T2/T3 outputs), exactly
// the same "external kernel-built artifact captured, never ported" split the
// cavity `outline` stage uses.
import { bridgeAssemblyFixture } from './bridgeAssembly.test-fixtures.ts';
import { bridgeFixture } from './bridge.test-fixtures.ts';
import { makeEllipseConnectorProfile } from './connector.ts';
import { shapePonticBase, measurePonticRelief } from './ponticInterface.ts';
import type {
  PonticInterfaceStyle,
  PonticInterfaceParams,
  PonticBaseFootprint,
  PonticBaseResolution,
  RidgeCrestCylinder,
} from './ponticInterface.ts';
import { buildBvh } from '../bvh/build.ts';
import { computePseudonormals } from '../sdf/pseudonormals.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';

// --- fixture defaults mirrored from bridgeAssembly.test-fixtures.ts ---
// (the fixture's own buildConnector uses these defaults; kept here so the derived
// connector frames match the fixture's connector meshes byte-for-byte — the byte
// guard proves it).
const OVERLAP_MM = 0.5;
const CONNECTOR_CENTRE_Z_MM = 2.2;

// --- the pontic-relief measurement rig (mirrors test/golden/bridge-acceptance.test.ts) ---
const RIDGE = { ridgeCrestRadiusMm: 3, ridgeCrestCenterZMm: 1, ridgeHalfLengthMm: 5, ridgeCrestSegments: 160, ridgeStations: 16 } as const;
const FOOTPRINT: PonticBaseFootprint = { stationMinMm: -4, stationMaxMm: 4, angularHalfSpanRad: (60 * Math.PI) / 180 };
const RES: PonticBaseResolution = { meshStations: 24, meshAngularSegments: 48, sampleStations: 40, sampleAngularSegments: 80 };

/** The configured relief params per style (matching the zirconia profile the live
 * UI defaults to: ponticHygienicClearanceMm 2.0 / ponticRidgeLapReliefMm 0.05 /
 * ponticOvateDepthMm 1.0). Kept here so the baked measurement is built at exactly
 * the value the client displays from the profile. */
const STYLE_PARAMS: Record<PonticInterfaceStyle, { params: PonticInterfaceParams; configuredReliefMm: number }> = {
  hygienic: { params: { clearanceMm: 2.0 }, configuredReliefMm: 2.0 },
  ridgeLap: { params: { reliefMm: 0.05 }, configuredReliefMm: 0.05 },
  ovate: { params: { depthMm: 1.0 }, configuredReliefMm: 1.0 },
};

function fixtureCrest(): RidgeCrestCylinder {
  return { axisPointMm: [0, 0, RIDGE.ridgeCrestCenterZMm], mesialDistalDir: [1, 0, 0], buccalDir: [0, 1, 0], upDir: [0, 0, 1], radiusMm: RIDGE.ridgeCrestRadiusMm };
}

/** Worst |measured − configured| relief for one style, measured by the real T3
 * instrument on the analytic ridge (µm-scale, the ±20 µm acceptance evidence). */
function measureStyleRelief(style: PonticInterfaceStyle): number {
  const fx = bridgeFixture(RIDGE);
  const gingiva = fx.ridge.mesh;
  const bvh = buildBvh(gingiva);
  const pn = computePseudonormals(gingiva);
  const crest = fixtureCrest();
  const shaped = shapePonticBase(crest, style, STYLE_PARAMS[style].params, FOOTPRINT, RES);
  return measurePonticRelief(gingiva, bvh, pn, shaped.samples, crest).primary.maxAbsDeviationMm;
}

/** Max distance from any margin-loop point to its nearest unit-surface vertex
 * (mm). For a margin ring that is a byte-exact subset of the intaglio surface
 * (the closed-form fixture) this is exactly 0 — the per-abutment fit readout. A
 * pure derived value (no magic constant), the authoritative fit re-measured by
 * QC's `marginFit:<abutment>` gate on the assembled solid. */
function maxPointToVertexMm(loop: readonly Vec3[], mesh: IndexedMesh): number {
  let worst = 0;
  const p = mesh.positions;
  for (const [lx, ly, lz] of loop) {
    let best = Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const dx = p[i]! - lx;
      const dy = p[i + 1]! - ly;
      const dz = p[i + 2]! - lz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) best = d2;
    }
    const d = Math.sqrt(best);
    if (d > worst) worst = d;
  }
  return worst;
}

function serMesh(mesh: IndexedMesh): { positions: number[]; indices: number[] } {
  return { positions: Array.from(mesh.positions), indices: Array.from(mesh.indices) };
}

/**
 * Canonical JSON serialization of the client bridge fixture asset. Deterministic:
 * fixed key order, exact Float64 round-trip, single trailing newline.
 */
export function serializeBridgeFixture(): string {
  const fx = bridgeAssemblyFixture();
  const { R, spanMm } = fx.params;
  const centres = [-spanMm, 0, spanMm]; // mesial / pontic / distal (fixture placement)

  const units = fx.units.map((u) => ({
    label: u.label,
    kind: u.kind,
    insertionAxisMm: [u.insertionAxis[0], u.insertionAxis[1], u.insertionAxis[2]],
    marginFitMm: maxPointToVertexMm(u.marginLoop, u.innerSurfaceMesh),
    mesh: serMesh(u.mesh),
    inner: serMesh(u.innerSurfaceMesh),
    outer: serMesh(u.outerSurfaceMesh),
    marginLoop: u.marginLoop.map((p) => [p[0], p[1], p[2]]),
    fitRegion: u.kind === 'abutment'
      ? {
          axisPointMm: [u.fitRegion.axisPointMm[0], u.fitRegion.axisPointMm[1], u.fitRegion.axisPointMm[2]],
          axis: [u.fitRegion.axis[0], u.fitRegion.axis[1], u.fitRegion.axis[2]],
          maxRadialMm: u.fitRegion.maxRadialMm,
          minAxialMm: u.fitRegion.minAxialMm,
          maxAxialMm: u.fitRegion.maxAxialMm,
        }
      : null,
    die: u.die ? serMesh(u.die) : null,
  }));

  // Connector frames derived from the SAME fixture params as buildConnector, so a
  // default re-loft (bridgeConnectors job) reproduces the fixture connector meshes.
  const semiAxisMm = fx.params.connectorSemiAxisMm;
  const segments = fx.params.connectorSegments;
  const profile = makeEllipseConnectorProfile(semiAxisMm, semiAxisMm, segments);
  const profileFlat: number[] = [];
  for (const [uu, vv] of profile) profileFlat.push(uu, vv);
  function connectorFrame(cxA: number, cxB: number): { originMm: number[]; axisMm: number[]; spanMm: number } {
    const startX = cxA + R - OVERLAP_MM;
    const endX = cxB - R + OVERLAP_MM;
    return { originMm: [startX, 0, CONNECTOR_CENTRE_Z_MM], axisMm: [1, 0, 0], spanMm: endX - startX };
  }
  const connectors = fx.connectors.map((c, i) => {
    const frame = i === 0 ? connectorFrame(centres[0]!, centres[1]!) : connectorFrame(centres[1]!, centres[2]!);
    return {
      label: c.label,
      teeth: [c.teeth[0], c.teeth[1]],
      originMm: frame.originMm,
      axisMm: frame.axisMm,
      spanMm: frame.spanMm,
      semiAxisMm,
      segments,
      profileFlat,
      defaultMinAreaMm2: c.minAreaMm2,
    };
  });

  const ponticReliefByStyle: Record<string, { configuredReliefMm: number; maxAbsDeviationMm: number }> = {};
  for (const style of ['hygienic', 'ridgeLap', 'ovate'] as const) {
    ponticReliefByStyle[style] = {
      configuredReliefMm: STYLE_PARAMS[style].configuredReliefMm,
      maxAbsDeviationMm: measureStyleRelief(style),
    };
  }

  const payload = {
    generator:
      'scripts/generate-client-bridge-fixture.ts — bridgeAssemblyFixture(default) + T3 pontic-relief ' +
      'measurements + T4 connector frames, from packages/kernel/src/bridge/*.ts; regenerate with: ' +
      'npx tsx scripts/generate-client-bridge-fixture.ts. Byte-guarded by ' +
      'packages/kernel/src/bridge/bridge.fixture-asset.test.ts.',
    params: { R, r: fx.params.r, H: fx.params.H, h: fx.params.h, spanMm, connectorSemiAxisMm: semiAxisMm, connectorSegments: segments },
    sharedAxis: {
      directionMm: [0, 0, 1],
      acceptable: true,
      perAbutment: units.filter((u) => u.kind === 'abutment').map((u) => ({ label: u.label, marginFitMm: u.marginFitMm })),
    },
    units,
    connectors,
    ponticReliefByStyle,
  };
  return `${JSON.stringify(payload)}\n`;
}
