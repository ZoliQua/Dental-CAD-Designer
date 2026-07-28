// apps/client/src/engine/bridgeGeometry.ts
//
// Phase 6 Task 7 — loader for the CLIENT-side analytic 3-unit bridge fixture.
//
// ## Where this geometry comes from (synthetic-fixture-driven phase)
//
// Phase 6 is explicitly SYNTHETIC-FIXTURE-DRIVEN (docs/plans/phase-6-bridge.md
// "Fixture reality"): there is no real multi-abutment bridge scan + coupled
// T2/T3 geometry-capture in the client yet (a tracked real-case pending). So this
// loader is the bridge panel's geometry source in THIS phase — both the
// browser-lane critical-path test (ui/BridgeDesignPanel.dom.test.tsx) AND
// ui/BridgeDesignPanel.tsx's `start()` consume it. A later phase replaces it with
// a real bridge-geometry capture from the coupled abutment-surface/pontic stages
// (reviewer item; the ~280 KB asset bundle is the synthetic-phase cost).
//
// The geometry is NOT constructed here. It is the EXACT output of the kernel's
// own `bridgeAssemblyFixture` (+ the T3 pontic-relief measurements + the T4
// connector frames), serialized into the committed TEST ASSET
// `./bridgeFixture.asset.json` by `scripts/generate-client-bridge-fixture.ts`.
// The layer rule bars apps/client from importing kernel test CODE
// (ui → engine → kernel-workers → kernel), but DATA may cross the boundary — so
// the asset replaces any engine-side port of the construction (the P5-T8 lesson).
//
// Drift guard: packages/kernel/src/bridge/bridge.fixture-asset.test.ts
// regenerates the canonical serialization on every kernel test run and compares
// it byte-for-byte against the committed asset — a change to the kernel fixture
// FAILS that test until the asset is deliberately regenerated (npx tsx
// scripts/generate-client-bridge-fixture.ts), reviewed, and committed.
//
// PRODUCTION NOTE (corrected): this module is NOT test-only. In this
// synthetic-fixture-driven phase the production `ui/BridgeDesignPanel.tsx` also
// imports `buildBridgeFixture()` AS THE DISCLOSED DEMONSTRATION FIXTURE (the
// panel renders an un-missable synthetic-data banner over every stage; there is
// no real bridge-geometry capture yet — a tracked real-case pending). The
// browser-lane dom test consumes the same asset. It lives in engine/ so both the
// panel and the ui test may import it under the layer rule; DATA crosses the
// package boundary (never kernel test CODE).
import asset from './bridgeFixture.asset.json';
import type { IndexedBuffers } from './crownGeometry';

type Vec3 = readonly [number, number, number];

/** The FDI teeth the demonstration fixture models (mesial abutment · pontic ·
 * distal abutment). Lightweight (reads only the unit labels — no buffer
 * allocation), so the panel can compare the selected case's teeth against the
 * demo fixture and surface a mismatch WITHOUT building the ~280 KB geometry. */
export const BRIDGE_FIXTURE_TEETH: readonly number[] = (asset as { units: { label: string }[] }).units.map((u) =>
  Number(u.label),
);

export interface ClientBridgeUnit {
  label: string;
  kind: 'abutment' | 'pontic';
  insertionAxis: Vec3;
  /** Per-abutment margin-fit readout (mm) — byte-exact on the closed-form fixture. */
  marginFitMm: number;
  mesh: IndexedBuffers;
  inner: IndexedBuffers;
  outer: IndexedBuffers;
  marginLoop: Vec3[];
  fitRegion: {
    axisPointMm: Vec3;
    axis: Vec3;
    maxRadialMm: number;
    minAxialMm: number;
    maxAxialMm: number;
  } | null;
  die: IndexedBuffers | null;
}

export interface ClientBridgeConnector {
  label: string;
  teeth: readonly [number, number];
  originMm: Vec3;
  axisMm: Vec3;
  spanMm: number;
  /** The default ellipse semi-axis (mm) — the connector-editor slider's default. */
  semiAxisMm: number;
  segments: number;
  /** The default closed 2D profile, flat (u,v) pairs. */
  profileFlat: number[];
  defaultMinAreaMm2: number;
}

export interface ClientBridgePonticRelief {
  configuredReliefMm: number;
  maxAbsDeviationMm: number;
}

export interface ClientBridge {
  sharedAxis: {
    direction: Vec3;
    acceptable: boolean;
    perAbutment: readonly { label: string; marginFitMm: number }[];
  };
  units: ClientBridgeUnit[];
  connectors: ClientBridgeConnector[];
  ponticReliefByStyle: Record<string, ClientBridgePonticRelief>;
}

function buffers(m: { positions: number[]; indices: number[] }): IndexedBuffers {
  return { positions: Float64Array.from(m.positions), indices: Uint32Array.from(m.indices) };
}
function vec3(a: number[]): Vec3 {
  return [a[0]!, a[1]!, a[2]!];
}

/**
 * The analytic 3-unit bridge fixture (kernel `bridgeAssemblyFixture` defaults),
 * rebuilt into typed buffers from the committed asset. Frame: X = mesiodistal,
 * Y = buccolingual, Z = occlusal-up. Deterministic (Float64 values survive the
 * JSON round-trip bit-exactly).
 */
export function buildBridgeFixture(): ClientBridge {
  const a = asset as unknown as {
    sharedAxis: { directionMm: number[]; acceptable: boolean; perAbutment: { label: string; marginFitMm: number }[] };
    units: Array<{
      label: string;
      kind: 'abutment' | 'pontic';
      insertionAxisMm: number[];
      marginFitMm: number;
      mesh: { positions: number[]; indices: number[] };
      inner: { positions: number[]; indices: number[] };
      outer: { positions: number[]; indices: number[] };
      marginLoop: number[][];
      fitRegion: { axisPointMm: number[]; axis: number[]; maxRadialMm: number; minAxialMm: number; maxAxialMm: number } | null;
      die: { positions: number[]; indices: number[] } | null;
    }>;
    connectors: Array<{
      label: string;
      teeth: number[];
      originMm: number[];
      axisMm: number[];
      spanMm: number;
      semiAxisMm: number;
      segments: number;
      profileFlat: number[];
      defaultMinAreaMm2: number;
    }>;
    ponticReliefByStyle: Record<string, { configuredReliefMm: number; maxAbsDeviationMm: number }>;
  };
  return {
    sharedAxis: {
      direction: vec3(a.sharedAxis.directionMm),
      acceptable: a.sharedAxis.acceptable,
      perAbutment: a.sharedAxis.perAbutment.map((p) => ({ label: p.label, marginFitMm: p.marginFitMm })),
    },
    units: a.units.map((u) => ({
      label: u.label,
      kind: u.kind,
      insertionAxis: vec3(u.insertionAxisMm),
      marginFitMm: u.marginFitMm,
      mesh: buffers(u.mesh),
      inner: buffers(u.inner),
      outer: buffers(u.outer),
      marginLoop: u.marginLoop.map((p) => [p[0]!, p[1]!, p[2]!] as Vec3),
      fitRegion: u.fitRegion
        ? {
            axisPointMm: vec3(u.fitRegion.axisPointMm),
            axis: vec3(u.fitRegion.axis),
            maxRadialMm: u.fitRegion.maxRadialMm,
            minAxialMm: u.fitRegion.minAxialMm,
            maxAxialMm: u.fitRegion.maxAxialMm,
          }
        : null,
      die: u.die ? buffers(u.die) : null,
    })),
    connectors: a.connectors.map((c) => ({
      label: c.label,
      teeth: [c.teeth[0]!, c.teeth[1]!] as const,
      originMm: vec3(c.originMm),
      axisMm: vec3(c.axisMm),
      spanMm: c.spanMm,
      semiAxisMm: c.semiAxisMm,
      segments: c.segments,
      profileFlat: [...c.profileFlat],
      defaultMinAreaMm2: c.defaultMinAreaMm2,
    })),
    ponticReliefByStyle: Object.fromEntries(
      Object.entries(a.ponticReliefByStyle).map(([k, v]) => [k, { configuredReliefMm: v.configuredReliefMm, maxAbsDeviationMm: v.maxAbsDeviationMm }]),
    ),
  };
}
