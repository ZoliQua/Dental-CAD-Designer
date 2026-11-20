# Contributing to DQ Dental CAD

Thank you for your interest. Issues, bug reports with a reproducing mesh, and
pull requests are welcome.

## License of contributions

The project is licensed under the [Apache License 2.0](LICENSE). By
submitting a contribution you agree that it is licensed under the same terms
(Apache License 2.0, section 5), and that you have the right to submit it.

Never submit patient-identifying data. Scans must be anonymized (see
`test-fixtures/real-scans/README.md` for how the existing fixtures were
anonymized), and the git-ignored `scans/` directory is never committed.

## Before you open a pull request

Read [`CLAUDE.md`](CLAUDE.md) (the engineering invariants) and
[`docs/TECHNICAL.md`](docs/TECHNICAL.md). In short:

- **Accuracy over speed.** An approximating algorithm documents its error
  bound (`@errorBound`) and reports it where it matters clinically.
- **Float64 in the kernel**, deterministic results, with transcendental
  functions only through `detMath`.
- **Every destructive operation is journaled.**
- **QC gate thresholds are never weakened** to make a test pass. Clinical
  values live only in `packages/clinical-profiles`.
- **Tests first.** A new kernel algorithm gets property-based tests and an
  analytic case with a closed-form answer. A bug fix adds a regression
  fixture.
- **Golden hashes** change only with a kernel version bump and an entry in
  `docs/CHANGELOG-kernel.md` that explains the numerical difference.
- **Strings in four languages.** Every UI string is added in EN, HU, DE and
  ES.

Run before pushing:

```bash
npm test
npm run lint && npm run typecheck
npm run test:e2e
```

## Attribution

Contributors are credited in the git history. The project's NOTICE file
credits the original author. Please keep it in derived works.
