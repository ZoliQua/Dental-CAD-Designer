// apps/client/src/engine/diagnosticBundle.test.ts
//
// Phase 8 Task 5 — the bundle builder's shape, determinism, and local helpers
// (environment collection, filename, download-deps fallback).
import { describe, expect, it } from 'vitest';
import type { CaseDocument } from '@dqcad/shared-types';
import { APP_VERSION } from '../appVersion';
import {
  buildDiagnosticBundle,
  collectEnvironment,
  DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
  diagnosticBundleFilename,
  downloadDiagnosticBundle,
  serializeDiagnosticBundle,
  type DiagnosticBundleEnvironment,
} from './diagnosticBundle';

const ENV: DiagnosticBundleEnvironment = {
  userAgent: 'UA',
  language: 'en',
  platform: 'P',
};

function emptyCase(): CaseDocument {
  return {
    id: 'case-xyz',
    schemaVersion: 2,
    createdAt: '2026-07-22T00:00:00.000Z',
    meshes: [],
    scene: [],
    restorations: [],
    measurements: [],
    history: [],
    settings: { materialProfileId: '', profileVersion: '' },
  };
}

describe('diagnosticBundle — structure & determinism', () => {
  it('carries the allowlisted top-level shape and pins the versions', async () => {
    const bundle = await buildDiagnosticBundle({
      error: null,
      caseDocument: emptyCase(),
      environment: ENV,
      manifoldVersion: null,
      now: () => '2026-07-22T12:00:00.000Z',
      log: [],
    });
    expect(Object.keys(bundle).sort()).toEqual(
      ['app', 'case', 'environment', 'error', 'generatedAt', 'log', 'schemaVersion'].sort(),
    );
    expect(bundle.schemaVersion).toBe(DIAGNOSTIC_BUNDLE_SCHEMA_VERSION);
    expect(bundle.app.appVersion).toBe(APP_VERSION);
    expect(bundle.app.kernelVersion).toBe('0.26.0');
    expect(bundle.app.manifoldVersion).toBeNull();
    expect(bundle.environment).toEqual(ENV);
  });

  it('is byte-identical across two builds with the same inputs (timestamps injected)', async () => {
    const input = {
      error: { name: 'Error', message: 'x', stack: null },
      caseDocument: emptyCase(),
      environment: ENV,
      now: () => '2026-07-22T12:00:00.000Z',
      log: [],
    } as const;
    const a = serializeDiagnosticBundle(await buildDiagnosticBundle(input));
    const b = serializeDiagnosticBundle(await buildDiagnosticBundle(input));
    expect(a).toBe(b);
  });

  it('defaults manifoldVersion to null (no authoritative browser constant)', async () => {
    const bundle = await buildDiagnosticBundle({
      error: null,
      caseDocument: null,
      environment: ENV,
      now: () => 'now',
      log: [],
    });
    expect(bundle.app.manifoldVersion).toBeNull();
  });
});

describe('diagnosticBundle — local helpers', () => {
  it('collectEnvironment is null-safe when navigator is absent', () => {
    const hadNavigator = 'navigator' in globalThis;
    // In the Node lane navigator is typically absent → all-null.
    if (!hadNavigator) {
      expect(collectEnvironment()).toEqual({ userAgent: null, language: null, platform: null });
    } else {
      const env = collectEnvironment();
      expect(env).toHaveProperty('userAgent');
    }
  });

  it('diagnosticBundleFilename is filesystem-safe (no colons/dots in the timestamp)', () => {
    const name = diagnosticBundleFilename('2026-07-22T12:00:00.000Z');
    expect(name).toBe('dqcad-diagnostic-2026-07-22T12-00-00-000Z.json');
    expect(name).not.toMatch(/[:]/);
  });

  it('downloadDiagnosticBundle returns false (never throws) when no DOM is available', () => {
    // No deps injected + Node lane (no document/URL.createObjectURL) → no-op false.
    expect(downloadDiagnosticBundle('{}', 'x.json')).toBe(false);
  });
});
