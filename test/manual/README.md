# Manual real-scan pipeline replications

Two standalone Node scripts, **not** part of any automated test run (see
"Why these are excluded from CI" below). They replicate, end to end, the
exact pipeline `apps/client/src/engine/importer.ts` +
`apps/client/src/engine/heatmap.ts` / `engine/section.ts` drive in the
browser — `parseMeshFile` → `intakeMesh` → `buildBvh` → `distanceHeatmap` /
`sectionMesh` — all through the real `@dqcad/kernel-workers` `WorkerPool`
(Node `worker_threads`, same job registry the browser's Web Worker pool
uses), against the real, checked-in clinical-scale scans in
`test-fixtures/real-scans/arch-case-01/`.

They exist because Task 9 (surface-distance heatmap) and Task 10
(cross-sections) each originally verified their real-scan behavior via a
throwaway, uncommitted Node script during that task's session (the sandbox's
browser automation couldn't drive a real file-upload at the time — see
`.superpowers/sdd/p1-task-9-report.md` / `p1-task-10-report.md`'s "Manual
verification" sections). Task 12 (Phase 1 wrap-up) committed clean rewrites
of both here per its review carry-over, so the replication is reproducible
and reviewable rather than a one-off.

## Files

- `heatmap-real-scan-replicate.ts` — bite0 (55,967 vertices) queried
  against lowerjaw (242,199 triangles) via `distanceHeatmap`; also
  self-checks `heatmap(bite0, bite0) ≡ 0` on the same real (non-synthetic)
  mesh. Mirrors Task 9's manual-verification numbers.
- `section-real-scan-replicate.ts` — a Z-through-bbox-center `sectionMesh`
  cut through `arch-case-01-bite1.stl` (non-watertight) and
  `arch-case-01-upperjaw.stl` (non-watertight), plus a cut with
  `computeCap: true` through the synthetic watertight `sphere-r5.stl`
  fixture to confirm the cap path. Mirrors Task 10's manual-verification
  numbers.

## How to run

```sh
npx tsx test/manual/heatmap-real-scan-replicate.ts
npx tsx test/manual/section-real-scan-replicate.ts
```

Both need the real Git LFS content for `test-fixtures/real-scans/` checked
out (`git lfs pull` if you only have pointer files) and take a few seconds
each (real worker spin-up + a few-hundred-K-triangle intake pass). Output is
plain `console.log` — triangle/vertex counts, elapsed milliseconds, and the
computed stats (min/max/mean/RMS for the heatmap script; polyline/point
counts and cap vertex/triangle counts for the section script) — the same
numbers quoted in `docs/demos/phase-1.md`'s acceptance evidence table and in
the Task 9/10 reports.

## Why these are excluded from CI

Neither file matches any Vitest project's `include` glob in
`vitest.config.ts` / `vitest.fuzz.config.ts` (every project's `include`
targets `src/**/*.test.ts` or `test/golden/**/*.test.ts` — `test/manual/**`
isn't `test/golden/**`, and these files don't even have a `.test.ts`
suffix), so `npm test` / `npm run test:golden` / `npm run test:fuzz` never
pick them up. They're deliberately plain, human-run scripts: their job is to
produce evidence numbers for a report, not to assert pass/fail on every
push — the actual pass/fail acceptance coverage for heatmap/section
correctness lives in the real automated tests (`packages/kernel-workers/src/
distanceHeatmap.test.ts`, `packages/kernel/src/section/polyline.test.ts`,
`packages/kernel-workers/src/sectionMeshJob.test.ts`).

`npm run typecheck`'s root `tsconfig.json` DOES include `test/` (see its
`include` array), so these scripts are still type-checked on every CI run
even though they never execute there.
