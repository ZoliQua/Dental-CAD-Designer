# Stand-in prep-die scan

`standin-prep-die.stl` is a **procedural, synthetic** truncated cone with a
shoulder margin collar (see `buildStandinPrepDie` in
`scripts/generate-fixtures.ts`) — it is **NOT a real scan**.

- Real arch/antagonist fixtures are imported (anonymized) by Task 8; once
  that lands, its outputs belong alongside this file, under
  `test-fixtures/real-scans/`.
- A real prep-die / crown-prep case is still needed from the project owner
  before Phase 3 acceptance — this stand-in only unblocks pipeline
  plumbing (intake, QC gates, margin-detection scaffolding) that needs
  *some* prep-shaped mesh to run against before that real case arrives.

Do not treat this file's dimensions or geometry as clinically meaningful.
