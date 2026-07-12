# ADR-001: Persist post-intake meshes as binary STL; discard raw source bytes

**Status:** Accepted

## Context

`apps/client/src/engine/importer.ts`'s import pipeline is: read raw file
bytes -> `parseMeshFile` (worker) -> optional `rescaleMesh` -> `intakeMesh`
(weld / drop-degenerate / orient / analyze, worker) -> `MeshStore.register`
-> `CaseStore.registerImportedMesh` (journals `import-mesh`, and
`unit-rescale` if applied).

Once `intakeMesh` returns, the raw uploaded bytes (the `Uint8Array` read off
`File.stream()`) are never retained anywhere: the `ArrayBuffer` backing them
is transferred into the `parseMeshFile` worker call and, after parsing,
simply goes out of scope. Only the mesh's `contentHash` (SHA-256 over the
POST-intake `positions`/`indices` byte layout — see
`packages/kernel-workers/src/hash.ts`'s `hashMeshContent`) and, once the case
is first saved, a re-serialized binary STL of that post-intake geometry
(`kernel-workers`' `serializeMeshStl` job, uploaded to the server's
content-addressed store and hashed separately as `MeshAsset.fileHash`) are
ever persisted. `engine/persistence.ts`'s `openCase` reads that same
post-intake STL back (`parseMeshFile` + `weldMeshSoup` — the "intake-skip"
path, since dropDegenerate/orient are structural no-ops on already-clean
geometry) and reconstructs the mesh; it never sees the original source file
again.

This was a deliberate simplicity choice for Phase 1 (no separate raw-file
blob store, one content-addressed store keyed by the thing actually
rendered/measured), not an oversight — but it has a real, documented
consequence for a later feature: PLAN.md §6.3's journal-replay harness
(Task 8, `scripts/replay-journal.ts`) is specced to record a case journal
(import, rescale, repair ops) and replay it fresh, asserting every output
hash is identical. A literal replay of the `import-mesh` operation would
need to re-run `parseMeshFile` + `intakeMesh` against the ORIGINAL source
bytes — which, per this ADR, no longer exist anywhere once a case is saved
and reloaded.

## Decision

Persist only the mesh's POST-intake geometry (as binary STL, float32
per-vertex — see `kernel-workers/src/jobs/io.ts`'s "Why binary STL for
storage" module doc for the resulting lossy-round-trip precision bound).
Raw source file bytes are never written to server storage and are not
retrievable after the importing session ends.

**§6.3 replay mitigation:** the journal-replay harness (Task 8) replays
starting from the STORED post-intake mesh, not from the original source
file. Concretely, its `import-mesh` replay step is `weldMeshSoup(stored STL
bytes)` (an "intake-skip" reconstruction — see `jobs/io.ts`), asserting the
result's `contentHash` matches the journaled `outputHashes[0]`, rather than
a full `parseMeshFile` + `intakeMesh` re-run from an unavailable original
file. This is a genuine, narrower proof than "replay reproduces intake
itself" — it proves the STORED mesh reconstructs deterministically, not that
intake is deterministic against the original scan bytes (that determinism is
instead covered by `test/golden/intake.test.ts`'s own goldens, which DO keep
their source fixtures on disk).

## Consequences

- A case's saved geometry is never bit-for-bit identical to what was
  originally uploaded (float64 -> float32 -> float64 round trip through
  binary STL); this is within the 1 µm display-resolution budget and is
  already documented at `MeshAsset.fileHash`'s doc (`packages/shared-types`)
  and `jobs/io.ts`'s module doc.
- `MeshAsset.contentHash` deliberately stays the ORIGINAL in-session hash
  after a reload (never recomputed from the reloaded, quantized buffers) —
  see `engine/persistence.ts`'s `openCase` doc — so journal/`SceneNode`
  linkage survives the round trip even though the raw bytes underneath it
  don't.
- The journal-replay harness (PLAN §6.3, Task 8) can only validate
  reproducibility of the STORED mesh, not of the original intake computation
  against the original scan. If source-byte retention is added later (e.g. a
  separate raw-upload blob store, keyed by the `fileHash` `parseMeshFile`
  already computes worker-side — see ADR for Phase 2 Task 1's worker-side
  hashing), the replay harness can be strengthened to a full
  `parseMeshFile` + `intakeMesh` re-run at that point; no journal schema
  change is needed to do so; `Operation.inputHashes[0]` already carries the
  raw-file hash that would key such a store.
- No separate raw-file storage/GC/retention policy is needed for Phase 1/2
  (smaller server storage footprint; one content-addressed store, not two).
