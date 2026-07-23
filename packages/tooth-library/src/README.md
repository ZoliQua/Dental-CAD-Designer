# Tooth asset format

This document is the format spec for `@dqcad/tooth-library` — read this
before importing a third-party anatomical tooth library into DQ-Dental-CAD.

## What is a tooth asset

A tooth asset is **two separately-addressable files**:

1. **Mesh bytes** — a watertight, closed-solid, binary STL file (see
   `@dqcad/io`'s `writeStlBinary`/`parseStl`). Content-addressed: its
   identity is `SHA-256(bytes)`, lowercase hex.
2. **Metadata JSON** — matches the `ToothAssetMetadata` TypeScript
   interface in `schema.ts`:

   ```ts
   interface ToothAssetMetadata {
     fdi: FdiTooth; // 11-18 / 21-28 / 31-38 / 41-48
     version: string; // semver-shaped, bump on ANY value change
     toothType: 'incisor' | 'molar'; // more types are additive, not a closed union in practice
     provenance: string; // REQUIRED — where this anatomy came from
     landmarks: Record<string, [number, number, number]>; // named points, mm, in canonicalFrame space
     canonicalFrame: {
       origin: [number, number, number];
       mesialDistal: [number, number, number]; // unit vector, + = distal
       buccoLingual: [number, number, number]; // unit vector, + = buccal/labial
       occlusoGingival: [number, number, number]; // unit vector, + = occlusal/incisal
     };
     morphTargets: Array<{ name: string; vertexDeltas: number[] }>;
     meshChecksum: string; // SHA-256 hex of the mesh bytes (see above)
     metadataChecksum: string; // SHA-256 hex of every OTHER field, canonically serialized
   }
   ```

## Landmarks

`landmarks` is an open `Record<string, Vec3>` — the SET of names that make
sense depends on `toothType`. This package's own generators populate:

| toothType | landmark names |
| --- | --- |
| `incisor` | `incisalEdge`, `cingulum`, `mesialMarginalRidge`, `distalMarginalRidge`, `mesialContact`, `distalContact` |
| `molar` | `mesiobuccalCusp`, `distobuccalCusp`, `mesiolingualCusp`, `distolingualCusp`, `centralFossa`, `mesialMarginalRidge`, `distalMarginalRidge` |

A third-party asset for a different tooth type (canine, premolar) should
follow the same naming spirit (`<location><Feature>`, camelCase) but is not
required to use these exact names — the anatomy-placement stage (Task 5)
looks landmarks up by name and only requires the ones it actually consumes
for a given `toothType`.

Every landmark position is expressed in the asset's own `canonicalFrame`
space (see below) — NOT necessarily the same space the mesh's own vertex
positions use unless `canonicalFrame` is the identity frame (origin at
zero, axes = the standard basis), which is what this package's own
generators use (see `generate/incisor.ts`/`generate/molar.ts`).

## Canonical frame

`canonicalFrame` names the tooth's own local mesial-distal /
bucco-lingual / occluso-gingival axes, each a unit vector, mutually
orthogonal (checked to ~0.057 degrees / 1 milliradian by
`assertOrthonormalFrame`, enforced by `validateToothAssetMetadataShape`).
Sign convention: `mesialDistal` increases toward DISTAL, `buccoLingual`
increases toward BUCCAL/LABIAL, `occlusoGingival` increases toward
OCCLUSAL/INCISAL. Downstream code (adaptation/morphing, Task 3) reads
things like "cusp height along `occlusoGingival`" relative to this frame —
an asset that gets this frame wrong will silently corrupt every
landmark-relative computation, which is why orthonormality is enforced at
load time rather than merely documented.

## Morph targets

Each `MorphTarget` is a named, linear shape variation: `vertexDeltas` is a
flat `[dx0, dy0, dz0, dx1, dy1, dz1, ...]` array, one triple per mesh
vertex, in the **same vertex order as the mesh's own positions** — i.e.
`vertexDeltas.length === 3 * (mesh vertex count)`, and vertex `i`'s delta
applies to vertex `i`. A consumer applies a target at some weight `w` in
`[0, 1]` as `position[i] + w * delta[i]` (weight application itself is the
adaptation stage's job, Task 3 — this format only carries the deltas).

**Important for third-party assets**: binary STL has no vertex-index
channel, so "the same mesh" read back from a `.stl` file is only guaranteed
to have the same TOPOLOGY/positions as when it was authored — never
necessarily the same per-vertex NUMBERING (whichever tool re-parses/
re-welds the triangle soup determines vertex order for itself). Compute
`vertexDeltas` against **the exact vertex order your own mesh file
produces when parsed and welded by `@dqcad/kernel`'s `intake()`
(default weld epsilon)** — that is the canonicalization every consumer
(`loader.ts`) performs. This package's own starter set follows exactly
this rule (see `assets.ts`'s module doc for the full reasoning) — it does
NOT use its procedural generators' own internal vertex ordering.

## Checksums

Both checksums are **corruption-detection**, not a security/authenticity
primitive (same threat model as `@dqcad/clinical-profiles`'s
`MaterialProfile.checksum`) — "did this file get mangled", not "was this
tampered with by an adversary". Compute them with this package's own
`computeMeshChecksum(meshBytes)` and `computeToothAssetMetadataChecksum(
metadataWithoutChecksumField)` (both reuse `@dqcad/clinical-profiles`'s
SHA-256/canonical-JSON primitives — see `schema.ts`'s module doc). A
mismatch on EITHER checksum is a loud, typed error at load time
(`ToothMeshChecksumError` / `ToothAssetMetadataChecksumError`) — never a
silent fallback.

## Loading an asset

```ts
import { loadToothAssetFromBytes, loadToothAssetFromServer } from '@dqcad/tooth-library';

// From files you already have (a third-party import script):
const asset = loadToothAssetFromBytes(metadataJson, meshBytes);

// From the running server (see apps/server's routes below):
const asset2 = await loadToothAssetFromServer('http://localhost:4100', 11);

// asset.mesh: IndexedMesh (Float64, kernel-native)
// asset.landmarks / asset.canonicalFrame / asset.morphTargets
```

## Backend routes (apps/server)

- `GET /api/tooth-library` — lists every currently-stored asset's
  `{ fdi, version, toothType }`.
- `GET /api/tooth-library/:fdi` — the full metadata JSON for the latest
  version of that FDI's asset (404 if none stored). The mesh bytes
  themselves are fetched separately via the SAME content-addressed store
  Phase 1 already built for scan meshes: `GET /api/meshes/:hash`, where
  `:hash` is the metadata's own `meshChecksum` — no separate binary route
  for tooth-library, deliberately (see
  `apps/server/src/tooth-library-storage.ts`'s module doc).

Assets are immutable once stored: re-seeding with the same `{fdi,
version}` and byte-identical content is a no-op; a genuine content change
MUST bump `version` (mirrors mesh-storage's own "write-once,
content-addressed" contract).

## Adding a tooth beyond this task's starter set

This task ships 5 FDI codes: `12/11/21/22` (incisors) and `16` (one
molar) — see `generate/README.md`'s YAGNI note for how to add the
remaining 27 by either (a) adding a size-parameter entry to an EXISTING
generator (`toothParams.ts`), for another incisor/molar-shaped tooth, or
(b) writing a new generator for a genuinely different tooth type
(canine, premolar) and a matching landmark set in this doc's table above.
A real (non-placeholder) anatomical asset can replace ANY starter asset at
any time by satisfying this format alone — no generator code is a
dependency of the format itself.
