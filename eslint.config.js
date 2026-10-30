import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

const boundaryElements = [
  { type: 'ui', pattern: 'apps/client/src/ui/**' },
  { type: 'engine', pattern: 'apps/client/src/engine/**' },
  { type: 'state', pattern: 'apps/client/src/state/**' },
  { type: 'kernel-workers', pattern: 'packages/kernel-workers/**' },
  { type: 'kernel', pattern: 'packages/kernel/**' },
  { type: 'io', pattern: 'packages/io/**' },
  { type: 'cad-pipeline', pattern: 'packages/cad-pipeline/**' },
  { type: 'clinical-profiles', pattern: 'packages/clinical-profiles/**' },
  { type: 'tooth-library', pattern: 'packages/tooth-library/**' },
  { type: 'traceability', pattern: 'packages/traceability/**' },
  { type: 'shared-types', pattern: 'packages/shared-types/**' },
];

/** Cross-platform determinism rules — see the block that applies them. */
const DETERMINISTIC_MATH_RULES = {
  'no-restricted-properties': [
    'error',
    ...[
      'sin',
      'cos',
      'tan',
      'asin',
      'acos',
      'atan',
      'atan2',
      'exp',
      'expm1',
      'log',
      'log1p',
      'log2',
      'log10',
      'pow',
      'sinh',
      'cosh',
      'tanh',
      'asinh',
      'acosh',
      'atanh',
      'cbrt',
    ].map((property) => ({
      object: 'Math',
      property,
      message:
        'Math transcendentals are not bit-identical across platforms — use the detMath port (detSin, detCos, detAtan2, …) from @dqcad/kernel.',
    })),
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: "BinaryExpression[operator='**'], AssignmentExpression[operator='**=']",
      message: '`**` is Math.pow (not bit-identical across platforms) — multiply, or use detPow.',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { boundaries },
    settings: {
      'boundaries/elements': boundaryElements,
      'import/resolver': {
        typescript: {
          // Cover every workspace package/app so bare `@dqcad/*` specifiers
          // (exports-only package.json, no `main`) and relative `.js`-suffixed
          // imports of `.ts` source files both resolve during lint — without
          // this, boundaries/dependencies treats every intra-repo import as
          // "unknown" and silently never fires.
          project: ['tsconfig.base.json', 'apps/*/tsconfig.json', 'packages/*/tsconfig.json'],
          alwaysTryTypes: true,
          noWarnOnMultipleProjects: true,
        },
      },
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            {
              from: { element: { types: 'ui' } },
              allow: { to: { element: { types: { anyOf: ['engine', 'state', 'shared-types'] } } } },
            },
            {
              from: { element: { types: 'engine' } },
              allow: {
                to: {
                  element: {
                    types: {
                      anyOf: [
                        'kernel-workers',
                        'state',
                        'shared-types',
                        'clinical-profiles',
                        'traceability',
                      ],
                    },
                  },
                },
              },
            },
            {
              // Phase 7 Task 5: the QC traceability document's shared
              // builder/renderer — a leaf package importable by BOTH the
              // server and the client engine (see packages/traceability/
              // src/index.ts's placement doc). Depends only on shared-types
              // (the document type + JSON Schema) and clinical-profiles'
              // canonical-JSON primitive (the same reuse precedent as
              // tooth-library).
              from: { element: { types: 'traceability' } },
              allow: {
                to: { element: { types: { anyOf: ['clinical-profiles', 'shared-types'] } } },
              },
            },
            {
              from: { element: { types: 'clinical-profiles' } },
              allow: { to: { element: { types: 'shared-types' } } },
            },
            {
              // A leaf package like clinical-profiles (PLAN.md's tooth
              // asset library) — pure TS, no DOM/Three.js. It generates its
              // starter meshes with `@dqcad/kernel` (IndexedMesh, watertight
              // analysis), parses/writes them with `@dqcad/io` (STL bytes),
              // and reuses `@dqcad/clinical-profiles`' SHA-256/canonical-JSON
              // checksum primitives (see that package's index.ts) rather
              // than forking a second implementation.
              from: { element: { types: 'tooth-library' } },
              allow: {
                to: {
                  element: {
                    types: { anyOf: ['kernel', 'io', 'clinical-profiles', 'shared-types'] },
                  },
                },
              },
            },
            {
              from: { element: { types: 'state' } },
              allow: { to: { element: { types: 'shared-types' } } },
            },
            {
              // kernel-workers also depends on cad-pipeline as of Phase 4 Task 9:
              // the `runQc` worker job orchestrates cad-pipeline's QC gate suite
              // (`runCrownQc`) off the UI thread — runner.ts's own module doc names
              // the client worker as an intended caller of the gates ("callable
              // identically from a browser Worker ... and from the Node server").
              // Acyclic: cad-pipeline imports only kernel/io/shared-types, never
              // kernel-workers — so this adds a dependency edge, not a cycle.
              //
              // ...and on tooth-library as of Phase 9 Task 4: the `loadToothAsset`
              // job verifies a tooth-library asset fetched by the client engine
              // (checksums, watertight parse) off the UI thread, through the
              // format-only `@dqcad/tooth-library/bytes` subpath. Acyclic:
              // tooth-library imports only kernel/io/clinical-profiles/shared-types.
              from: { element: { types: 'kernel-workers' } },
              allow: {
                to: {
                  element: {
                    types: { anyOf: ['kernel', 'io', 'cad-pipeline', 'tooth-library', 'shared-types'] },
                  },
                },
              },
            },
            {
              from: { element: { types: 'cad-pipeline' } },
              allow: { to: { element: { types: { anyOf: ['kernel', 'io', 'shared-types'] } } } },
            },
            {
              from: { element: { types: 'kernel' } },
              allow: { to: { element: { types: 'shared-types' } } },
            },
            {
              from: { element: { types: 'io' } },
              allow: { to: { element: { types: 'shared-types' } } },
            },
          ],
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['packages/kernel/**', 'packages/io/**', 'packages/cad-pipeline/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'three',
              message:
                'kernel, io, and cad-pipeline are Float64, render-agnostic layers — three.js belongs only in apps/client/src/engine.',
            },
          ],
        },
      ],
    },
  },
  {
    // Determinism across platforms (CLAUDE.md hard invariant 2): ECMAScript's
    // transcendental Math functions are implementation-approximated, and V8's
    // differ in the last bit between arm64 and x64. Geometry code calls the
    // kernel's pure-IEEE fdlibm port (packages/kernel/src/math/detMath.ts)
    // instead; `**` is `Math.pow`. Tests may compare against `Math.*`.
    files: [
      'packages/kernel/src/**',
      'packages/io/src/**',
      'packages/cad-pipeline/src/**',
      'packages/tooth-library/src/**',
      'apps/server/src/**',
      // the client engine modules whose geometry feeds kernel jobs
      'apps/client/src/engine/axis.ts',
      'apps/client/src/engine/bridgeCaseGeometry.ts',
      'apps/client/src/engine/bridgeDesign.ts',
      'apps/client/src/engine/crownGeometry.ts',
    ],
    ignores: ['**/*.test.ts', 'packages/kernel/src/math/detMath.ts'],
    rules: DETERMINISTIC_MATH_RULES,
  },
  {
    // The golden harness libraries and golden tests BUILD the geometry whose
    // hashes are pinned — the same rule, tests included.
    files: ['scripts/*-lib.ts', 'test/golden/**/*.ts'],
    rules: DETERMINISTIC_MATH_RULES,
  },
  {
    files: ['apps/client/src/ui/**', 'apps/client/src/state/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['three', 'three/*'],
              message:
                'ui/ and state/ are React/zustand layers — three.js objects belong only in apps/client/src/engine (mount via engine/SceneManager and subscribe through state/).',
            },
          ],
        },
      ],
    },
  },
);
