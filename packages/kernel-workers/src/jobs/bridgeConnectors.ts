// jobs/bridgeConnectors.ts — the BRIDGE CONNECTORS worker job (Phase 6 Task 4):
// for each adjacent unit pair, build the deterministic ruled connector LOFT
// between its two closed 2D profiles (@dqcad/kernel's `loftConnectorProfiles`)
// and measure its fail-safe minimum cross-section area
// (`measureConnectorMinArea` — the exact closed-form ideal min + the sampled
// live-readout instrument + the rigorous station-margin lower bound the gate
// consumes). A thin driver over the kernel ops — it computes NO value the ops
// don't, so a payload yields byte-identical connector meshes + measured areas
// vs a direct kernel call (pinned by bridgeConnectorsJob.test.ts).
//
// ## Progress / cancellation
//
// One connector is FAST (a small ruled loft + a few dozen bounded section
// queries), so progress is PER-CONNECTOR (connector i of N → i/N) with a
// cooperative cancel check before each connector; `checkCancel` throws
// `JobCancelledError`. The job also checks cancellation up front.
//
// `.ts` extension: reachable from the Node worker entry's import closure — see
// CLAUDE.md's "Import extension convention".
import {
  buildConnectorFrame,
  loftConnectorProfiles,
  measureConnectorMinArea,
  type Vec2,
  type Vec3,
} from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';

/** One connector's inputs: its frame (origin/axis/span) + its two closed 2D
 * profiles (flat u,v pairs — transferable), rebuilt to `Vec2[]` in the job. */
export interface BridgeConnectorInputPayload {
  originMm: Vec3;
  axisMm: Vec3;
  spanMm: number;
  /** Flat (u,v) pairs for profile A / B (length = 2·vertexCount). */
  profileAFlat: Float64Array;
  profileBFlat: Float64Array;
}

export interface BridgeConnectorsPayload {
  connectors: readonly BridgeConnectorInputPayload[];
  /** Section stations for the sampled instrument (default 63). */
  stationCount?: number;
}

export interface BridgeConnectorResultPayload {
  positions: Float64Array;
  indices: Uint32Array;
  /** The fail-safe gate value (mm²) — never over-reports the solid's min. */
  minAreaMm2: number;
  /** The exact closed-form ideal-ring minimum (mm²). */
  analyticMinAreaMm2: number;
  /** The raw sampled (live-readout) minimum (mm²). */
  sampledMinAreaMm2: number;
  /** The rigorous station margin (mm²). */
  stationMarginMm2: number;
  /** The tessellation cross-check term (mm²). */
  sampledVsAnalyticMaxAbsMm2: number;
  atStationMm: number;
}

export interface BridgeConnectorsResult {
  connectors: readonly BridgeConnectorResultPayload[];
  /** Minimum measured connector area across the bridge (mm²). */
  minAreaMm2: number;
}

function rebuildProfile(flat: Float64Array): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i]!, flat[i + 1]!]);
  return out;
}

function validate(payload: BridgeConnectorsPayload): void {
  if (payload.connectors.length === 0) {
    throw new TypeError('bridgeConnectors: at least one connector is required');
  }
  for (const c of payload.connectors) {
    if (!(c.spanMm > 0)) throw new TypeError(`bridgeConnectors: spanMm must be > 0, got ${c.spanMm}`);
    if (c.profileAFlat.length < 6 || c.profileBFlat.length < 6) {
      throw new TypeError('bridgeConnectors: each profile needs >= 3 vertices (>= 6 flat coords)');
    }
  }
}

/**
 * `bridgeConnectors` worker job — see this file's module doc. Builds + measures
 * every connector; byte-identical to direct kernel calls.
 *
 * @throws {TypeError} for empty connectors / invalid span/profiles (before heavy work).
 * @throws {JobCancelledError} on cooperative cancellation.
 * @throws propagates `loftConnectorProfiles`'s / `measureConnectorMinArea`'s
 * typed errors (@dqcad/kernel — degenerate/self-intersecting/mismatched profiles).
 */
export const bridgeConnectorsJob = async (
  payload: BridgeConnectorsPayload,
  ctx: JobContext,
): Promise<BridgeConnectorsResult> => {
  validate(payload);
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const stationCount = payload.stationCount ?? 63;
  const n = payload.connectors.length;
  const connectors: BridgeConnectorResultPayload[] = [];
  let minAreaMm2 = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    if (await ctx.cancelled()) throw new JobCancelledError();
    const c = payload.connectors[i]!;
    const frame = buildConnectorFrame(c.originMm, c.axisMm, c.spanMm);
    const profileA = rebuildProfile(c.profileAFlat);
    const profileB = rebuildProfile(c.profileBFlat);
    const { mesh } = loftConnectorProfiles(profileA, profileB, frame);
    const measurement = measureConnectorMinArea(mesh, frame, profileA, profileB, { stationCount });
    if (measurement.minAreaMm2 < minAreaMm2) minAreaMm2 = measurement.minAreaMm2;
    connectors.push({
      positions: mesh.positions,
      indices: mesh.indices,
      minAreaMm2: measurement.minAreaMm2,
      analyticMinAreaMm2: measurement.analytic.minAreaMm2,
      sampledMinAreaMm2: measurement.sampled.minAreaMm2,
      stationMarginMm2: measurement.sampled.stationMarginMm2,
      sampledVsAnalyticMaxAbsMm2: measurement.sampledVsAnalyticMaxAbsMm2,
      atStationMm: measurement.atStationMm,
    });
    ctx.progress((i + 1) / n);
  }

  ctx.progress(1);
  return { connectors, minAreaMm2 };
};
