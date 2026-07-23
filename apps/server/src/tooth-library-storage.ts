// apps/server/src/tooth-library-storage.ts
//
// Content-addressed tooth-library asset storage — Phase 4 Task 2's
// "backend" deliverable, built by REUSING P1 Task 11's mesh-storage
// pattern rather than reinventing it:
//
//   - Mesh bytes (binary STL) go through the EXACT SAME store as scan
//     meshes (`mesh-storage.ts`'s `storeMeshBytes`/`readMeshBytes` —
//     content-addressed by `sha256(bytes)`, write-once, idempotent on a
//     byte-identical re-write). This is why there is NO dedicated
//     "download a tooth-library mesh" route below: a tooth asset's mesh is
//     already reachable at the ordinary `GET /api/meshes/:hash` route
//     (app.ts), using the asset's own `metadata.meshChecksum` as `:hash`.
//   - Metadata JSON is small and keyed by `(fdi, version)` rather than by
//     its own content hash (a technician/UI wants "the current asset for
//     tooth 11", not "the metadata blob with hash abc123..."), so it gets
//     its own tiny write-once store here, structurally identical in spirit
//     to mesh-storage.ts's own integrity philosophy: write once, and if a
//     file already exists at that (fdi, version) path, assert its content
//     is IDENTICAL before treating the write as a no-op (never silently
//     overwrite a stored asset version with different bytes — that would
//     violate "immutable; versioned").
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  loadToothAssetMetadata,
  STARTER_TOOTH_ASSETS,
  type ToothAssetMetadata,
} from '@dqcad/tooth-library';
import { storeMeshBytes } from './mesh-storage.js';

/** Thrown by `seedToothLibraryAsset` if a metadata file already exists at
 * this asset's `(fdi, version)` path but its content disagrees with the
 * one being seeded — should be unreachable for THIS package's own
 * deterministic starter set (byte-identical generation every run), and
 * would only fire for a genuinely conflicting write (e.g. two different
 * assets somehow sharing a version string) — never silently resolved. */
export class ToothLibraryStorageIntegrityError extends Error {
  constructor(fdi: number, version: string) {
    super(
      `tooth-library storage integrity violation: a metadata file already exists for FDI ${fdi} ` +
        `version "${version}" with DIFFERENT content — refusing to overwrite (an asset version must ` +
        'be immutable; bump the version instead).',
    );
    this.name = 'ToothLibraryStorageIntegrityError';
  }
}

function metadataFileName(fdi: number, version: string): string {
  return `${fdi}-${version}.json`;
}

/**
 * Stores one asset's mesh bytes (via `storeMeshBytes`, the existing P1
 * content-addressed store — `meshDataDir` should be the SAME directory
 * `apps/server/src/app.ts` already passes to `storeMeshBytes` for scan
 * meshes, so `GET /api/meshes/:hash` serves tooth-library meshes too) and
 * metadata JSON (this module's own small `(fdi, version)`-keyed store
 * under `metadataDataDir`). Idempotent: re-seeding with byte-identical
 * content is a no-op.
 */
export async function seedToothLibraryAsset(
  metadataDataDir: string,
  meshDataDir: string,
  metadata: ToothAssetMetadata,
  meshBytes: Uint8Array,
): Promise<void> {
  const { hash } = await storeMeshBytes(meshDataDir, Buffer.from(meshBytes));
  if (hash !== metadata.meshChecksum) {
    // Unreachable in practice (assets.ts computes meshChecksum from these
    // exact bytes) — defensive, loud failure rather than seeding a
    // self-inconsistent asset.
    throw new Error(
      `seedToothLibraryAsset: FDI ${metadata.fdi} mesh bytes hash to ${hash}, but ` +
        `metadata.meshChecksum is ${metadata.meshChecksum} — refusing to seed a mismatched asset.`,
    );
  }

  await mkdir(metadataDataDir, { recursive: true });
  const filePath = join(metadataDataDir, metadataFileName(metadata.fdi, metadata.version));
  const json = JSON.stringify(metadata);

  const existing = await readFile(filePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing !== null) {
    if (existing !== json) {
      throw new ToothLibraryStorageIntegrityError(metadata.fdi, metadata.version);
    }
    return;
  }

  const tmpPath = `${filePath}.tmp-${randomUUID()}`;
  await writeFile(tmpPath, json, 'utf8');
  await rename(tmpPath, filePath);
}

/** Seeds every `@dqcad/tooth-library` starter asset — called once at
 * server startup (`app.ts`'s `buildApp`). Deterministic and idempotent, so
 * calling it on every process start (including in tests, with a fresh temp
 * dir each time) is cheap and safe — no separate "has this already run"
 * flag needed. */
export async function seedStarterToothLibrary(metadataDataDir: string, meshDataDir: string): Promise<void> {
  for (const starter of STARTER_TOOTH_ASSETS.values()) {
    await seedToothLibraryAsset(metadataDataDir, meshDataDir, starter.metadata, starter.meshBytes);
  }
}

export interface ToothLibraryListEntry {
  fdi: number;
  version: string;
  toothType: string;
}

async function readAllMetadataFiles(metadataDataDir: string): Promise<ToothAssetMetadata[]> {
  const entries = await readdir(metadataDataDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const assets: ToothAssetMetadata[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const raw: unknown = JSON.parse(await readFile(join(metadataDataDir, entry), 'utf8'));
    // Re-validated on every read (not just trusted from disk) — a file
    // corrupted after being written (disk fault, manual edit) fails loudly
    // here rather than serving bad metadata to a client.
    assets.push(loadToothAssetMetadata(raw));
  }
  return assets;
}

/** Lists every currently-stored asset's `{fdi, version, toothType}`,
 * sorted by FDI then version — `GET /api/tooth-library`. */
export async function listToothLibraryAssets(metadataDataDir: string): Promise<ToothLibraryListEntry[]> {
  const assets = await readAllMetadataFiles(metadataDataDir);
  return assets
    .map((a) => ({ fdi: a.fdi, version: a.version, toothType: a.toothType }))
    .sort((a, b) => (a.fdi !== b.fdi ? a.fdi - b.fdi : a.version.localeCompare(b.version)));
}

/** Reads the LATEST (highest-version, lexicographically — this task's
 * starter set never ships more than one version per FDI, so any
 * deterministic tie-break is fine) stored asset for `fdi`, or `null` if
 * none exists — `GET /api/tooth-library/:fdi`. */
export async function readLatestToothLibraryMetadata(
  metadataDataDir: string,
  fdi: number,
): Promise<ToothAssetMetadata | null> {
  const assets = await readAllMetadataFiles(metadataDataDir);
  const matching = assets.filter((a) => a.fdi === fdi);
  if (matching.length === 0) return null;
  matching.sort((a, b) => b.version.localeCompare(a.version));
  return matching[0]!;
}
