// packages/io/src/ply/golden.test.ts
//
// Golden-file regression for `parsePly` against the checked-in
// test-fixtures/real-scans/*/*.ply fixtures (Git LFS — requires
// `git lfs pull`, see this package's stl/golden.test.ts for the same
// pattern this file mirrors). Every one of the 8 real PLY fixtures is
// `binary_little_endian`, produced by an intraoral scanner; jaw meshes
// (upperjaw/lowerjaw) additionally carry a `comment anonymized` header
// line and a `property list uchar float texcoord` face property this
// parser deliberately doesn't read into `PlyMesh` (see plan.ts) — both
// are asserted on explicitly below rather than just ignored, so a
// regression in either code path would fail this test.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePly } from './parse.ts';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const realScansDir = join(repoRoot, 'test-fixtures', 'real-scans');

const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';

function assertNotLfsPointer(bytes: Uint8Array, label: string): void {
  const probe = new TextDecoder('utf8').decode(bytes.subarray(0, LFS_POINTER_PREFIX.length));
  if (probe === LFS_POINTER_PREFIX) {
    throw new Error(
      `${label} is a Git LFS pointer file, not the real binary content — run \`git lfs pull\` before ` +
        're-running this test.',
    );
  }
}

function readFixtureBytes(path: string): Uint8Array {
  const bytes = new Uint8Array(readFileSync(path));
  assertNotLfsPointer(bytes, path);
  return bytes;
}

const REAL_SCAN_CASES = ['arch-case-01', 'arch-case-02'] as const;
const REAL_SCAN_ROLES = ['upperjaw', 'lowerjaw', 'bite0', 'bite1'] as const;
// Verified by direct header inspection while implementing this parser (see
// this task's report): only the two jaw meshes per case carry the
// `comment anonymized` line and the `texcoord` face property; the bite
// meshes have neither.
const ROLES_WITH_TEXCOORD_AND_COMMENT: ReadonlySet<string> = new Set(['upperjaw', 'lowerjaw']);

interface RealScanManifest {
  meshes: Record<string, { ply: { vertexCount: number; faceCount: number } }>;
}

describe('golden: real-scan PLY fixtures (test-fixtures/real-scans)', () => {
  for (const caseId of REAL_SCAN_CASES) {
    const manifest = JSON.parse(
      readFileSync(join(realScansDir, caseId, 'manifest.json'), 'utf8'),
    ) as RealScanManifest;

    for (const role of REAL_SCAN_ROLES) {
      it(`${caseId}/${role}.ply: vertexCount and faceCount match manifest.json`, () => {
        const plyPath = join(realScansDir, caseId, `${caseId}-${role}.ply`);
        const bytes = readFixtureBytes(plyPath);
        const entry = manifest.meshes[role]!.ply;

        const mesh = parsePly(bytes);

        expect(mesh.diagnostics.format).toBe('ply-binary-le');
        expect(mesh.vertexCount).toBe(entry.vertexCount);
        expect(mesh.faceCount).toBe(entry.faceCount);
        expect(mesh.positions).toHaveLength(mesh.vertexCount * 3);
        expect(mesh.normals).not.toBeNull();
        expect(mesh.normals).toHaveLength(mesh.vertexCount * 3);
        // These fixtures are pure-triangle meshes (verified by header
        // inspection: face count in the STL sidecar equals faceCount here) —
        // fan-triangulation should never fire, so indices is exactly 3 per
        // source face and there are no fan-triangulation warnings.
        expect(mesh.indices).toHaveLength(mesh.faceCount * 3);
        expect(mesh.diagnostics.warnings.some((w) => w.includes('fan-triangulated'))).toBe(false);

        if (ROLES_WITH_TEXCOORD_AND_COMMENT.has(role)) {
          expect(mesh.diagnostics.warnings).toContain('comment: anonymized');
          expect(mesh.diagnostics.warnings.some((w) => w.includes('texcoord'))).toBe(true);
        } else {
          expect(mesh.diagnostics.warnings.some((w) => w.startsWith('comment:'))).toBe(false);
          expect(mesh.diagnostics.warnings.some((w) => w.includes('texcoord'))).toBe(false);
        }
      });
    }
  }
});
