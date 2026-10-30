// apps/client/src/engine/toothLibrary.ts
//
// Phase 9 Task 4 (ADR-022 Decision 5) — the anatomy template for a
// restoration's FDI comes from the server tooth library: the metadata from
// `GET /api/tooth-library/:fdi`, the mesh bytes from `GET /api/meshes/:hash`
// (the same "engine owns the network" pattern as persistence.ts). The fetched
// asset is NOT trusted: the `loadToothAsset` worker job re-verifies both
// checksums, parses the STL and gates on watertightness. Every way this can
// fail — no server (client-only deploy), an FDI the library lacks, an
// unreachable server, an asset failing verification — falls back to the
// built-in parametric placeholder WITH a named reason the panel shows; a
// corrupted asset is never placed.
//
// Anatomy provenance is disclosed but does not fail a gate by itself (ADR-022
// Decision 5): every gate measures the resulting shell, not the template.
import type { JobName, JobPayloadMap, JobResultMap, RunJobOptions } from '@dqcad/kernel-workers';
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import type { ServerStatus } from '../state/serverStatusStore';

const API_BASE = '/api';

/** How a fetched asset's anatomy was produced (`@dqcad/tooth-library`'s
 * `ToothAssetKind`; `unspecified` for an asset that does not say). */
export type AnatomyAssetKind = 'generator' | 'scanned' | 'licensed' | 'unspecified';

/** Why the built-in placeholder is used instead of a library asset.
 * `notSelected`: the user opted out of the library template (journaled).
 * The fit reasons (Phase 10 Task 5) come from the crown engine, after the
 * asset verified: `noCervicalRing` (an asset version without one cannot be
 * fitted), `fitRefused` (the kernel fit refused, its reason in `detail`),
 * `fitOverBound` (the fit residual exceeds the clinical bound). */
export type AnatomyFallbackReason =
  | 'notSelected'
  | 'offline'
  | 'fdiMissing'
  | 'unavailable'
  | 'verificationFailed'
  | 'noCervicalRing'
  | 'fitRefused'
  | 'fitOverBound';

export type AnatomySource =
  | {
      origin: 'library';
      fdi: number;
      version: string;
      toothType: string;
      assetKind: AnatomyAssetKind;
      provenance: string;
      meshChecksum: string;
      metadataChecksum: string;
    }
  | { origin: 'builtin'; reason: AnatomyFallbackReason; detail: string | null };

/** A library tooth in the shape the placement job consumes. */
export interface LibraryTooth {
  positions: Float64Array;
  indices: Uint32Array;
  canonicalFrame: { origin: Vec3; mesialDistal: Vec3; buccoLingual: Vec3; occlusoGingival: Vec3 };
  landmarks: Record<string, Vec3>;
  /** The verified cervical ring (ordered vertex indices), or `null` for an
   * asset version without one — then the template cannot be fitted. */
  cervicalRing: readonly number[] | null;
}

export interface ToothLibraryDeps {
  serverStatus: () => ServerStatus;
  fetch: typeof fetch;
  pool: {
    run<J extends JobName>(
      jobName: J,
      payload: JobPayloadMap[J],
      opts?: RunJobOptions,
    ): Promise<JobResultMap[J]>;
  };
}

export interface ResolvedAnatomy {
  /** `null` ⇒ use the built-in placeholder. */
  tooth: LibraryTooth | null;
  source: AnatomySource;
}

/** Verified assets, per FDI — failures are never cached (a later attempt
 * may find the server back). */
const verified = new Map<number, ResolvedAnatomy>();

export function __resetToothLibraryCacheForTests(): void {
  verified.clear();
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function builtin(reason: AnatomyFallbackReason, detail: string | null): ResolvedAnatomy {
  return { tooth: null, source: { origin: 'builtin', reason, detail } };
}

/** The anatomy template for `fdi` — see this module's doc. Never throws. */
export async function resolveLibraryTooth(
  fdi: FdiTooth,
  deps: ToothLibraryDeps,
): Promise<ResolvedAnatomy> {
  const cached = verified.get(fdi);
  if (cached) return cached;
  if (deps.serverStatus() === 'offline') return builtin('offline', null);

  let metadataJson: unknown;
  let meshBytes: Uint8Array;
  try {
    const metadataResponse = await deps.fetch(`${API_BASE}/tooth-library/${fdi}`);
    if (metadataResponse.status === 404) return builtin('fdiMissing', null);
    if (!metadataResponse.ok)
      return builtin('unavailable', `GET /tooth-library/${fdi}: ${metadataResponse.status}`);
    metadataJson = await metadataResponse.json();
    const meshChecksum = (metadataJson as { meshChecksum?: unknown }).meshChecksum;
    if (typeof meshChecksum !== 'string' || !/^[0-9a-f]{64}$/.test(meshChecksum)) {
      return builtin('verificationFailed', 'the library metadata has no valid meshChecksum');
    }
    const meshResponse = await deps.fetch(`${API_BASE}/meshes/${meshChecksum}`);
    if (!meshResponse.ok)
      return builtin('unavailable', `GET /meshes/${meshChecksum}: ${meshResponse.status}`);
    meshBytes = new Uint8Array(await meshResponse.arrayBuffer());
  } catch (error) {
    return builtin('unavailable', describe(error));
  }

  try {
    const r = await deps.pool.run('loadToothAsset', { metadataJson, meshBytes });
    const m = r.metadata;
    const resolved: ResolvedAnatomy = {
      tooth: {
        positions: r.positions,
        indices: r.indices,
        canonicalFrame: r.canonicalFrame,
        landmarks: r.landmarks,
        cervicalRing: r.cervicalRing,
      },
      source: {
        origin: 'library',
        fdi: m.fdi,
        version: m.version,
        toothType: m.toothType,
        assetKind: m.assetKind,
        provenance: m.provenance,
        meshChecksum: m.meshChecksum,
        metadataChecksum: m.metadataChecksum,
      },
    };
    verified.set(fdi, resolved);
    return resolved;
  } catch (error) {
    return builtin('verificationFailed', describe(error));
  }
}
