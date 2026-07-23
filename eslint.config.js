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
  { type: 'shared-types', pattern: 'packages/shared-types/**' },
];

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
                  element: { types: { anyOf: ['kernel-workers', 'state', 'shared-types', 'clinical-profiles'] } },
                },
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
                to: { element: { types: { anyOf: ['kernel', 'io', 'clinical-profiles', 'shared-types'] } } },
              },
            },
            {
              from: { element: { types: 'state' } },
              allow: { to: { element: { types: 'shared-types' } } },
            },
            {
              from: { element: { types: 'kernel-workers' } },
              allow: { to: { element: { types: { anyOf: ['kernel', 'io', 'shared-types'] } } } },
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
