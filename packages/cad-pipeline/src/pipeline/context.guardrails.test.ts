// packages/cad-pipeline/src/pipeline/context.guardrails.test.ts
//
// Phase 5 Task 1: proves the restoration-type guard rails (context.ts) — both
// the COMPILE-TIME narrowings (a stage typed for one restoration family cannot
// be handed a context of another) and the RUNTIME guards (`assertCrownContext`
// / `assertCavityContext` throw a typed error rather than letting a crown-only
// stage silently run on a cavity case).
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@dqcad/shared-types';
import {
  RestorationTypeMismatchError,
  assertCavityContext,
  assertCrownContext,
  type CavityPipelineContext,
  type CrownPipelineContext,
  type PipelineContext,
} from './context.ts';

// A minimal, valid PipelineContext (empty margin loops / neighbors are fine —
// these guards only look at `restorationType`).
function makeContext(restorationType: PipelineContext['restorationType']): PipelineContext {
  const axis: Vec3 = [0, 0, 1];
  return {
    restorationId: 'guard-test',
    restorationType,
    materialProfile: {
      id: 'standard-zirconia',
      version: '1.2.0',
      restorationParams: {
        cementGapMm: 0.05,
        marginalGapMm: 0.02,
        spacerStartMm: 0.8,
        minWallThicknessMm: 0.5,
        proximalContactPenetrationMm: 0.02,
        occlusalContactMm: 0,
      },
      connectorAreaMm2: { posteriorMm2: 9, anteriorMm2: 7 },
      undercutBlockoutThresholdMm: 0,
      occlusalMinWallThicknessMm: 0.5,
      maxChordDeviationMm: 0.005,
      inlayMinThicknessMm: 0.5,
      onlayMinThicknessMm: 0.5,
      cuspCoverageMinThicknessMm: 0.7,
      marginExclusionMm: 0.2,
    },
    insertionAxis: axis,
    targetMesh: { contentHash: 'h', mesh: { positions: new Float64Array(), indices: new Uint32Array() } },
    marginLoops: {},
    neighbors: {},
    antagonist: null,
    stages: {},
  };
}

describe('assertCrownContext', () => {
  it('narrows and passes for a crown context', () => {
    const ctx = makeContext('crown');
    expect(() => assertCrownContext(ctx)).not.toThrow();
  });

  it.each(['inlay', 'onlay', 'bridge'] as const)('throws RestorationTypeMismatchError for a %s context', (t) => {
    const ctx = makeContext(t);
    expect(() => assertCrownContext(ctx)).toThrow(RestorationTypeMismatchError);
    expect(() => assertCrownContext(ctx)).toThrow(/crown-only stage cannot run/);
  });
});

describe('assertCavityContext', () => {
  it.each(['inlay', 'onlay'] as const)('narrows and passes for a %s context', (t) => {
    const ctx = makeContext(t);
    expect(() => assertCavityContext(ctx)).not.toThrow();
  });

  it.each(['crown', 'bridge'] as const)('throws RestorationTypeMismatchError for a %s context', (t) => {
    const ctx = makeContext(t);
    expect(() => assertCavityContext(ctx)).toThrow(RestorationTypeMismatchError);
  });
});

describe('compile-time narrowing (type-level guard rail)', () => {
  it('a crown-only consumer rejects a cavity context and vice versa', () => {
    // These stand in for a stage function's context parameter type.
    const takesCrown = (c: CrownPipelineContext): void => {
      void c;
    };
    const takesCavity = (c: CavityPipelineContext): void => {
      void c;
    };

    const crown = makeContext('crown');
    const inlay = makeContext('inlay');
    assertCrownContext(crown);
    assertCavityContext(inlay);
    // After the asserts, `crown` is CrownPipelineContext and `inlay` is
    // CavityPipelineContext — each is accepted only by its own consumer.
    takesCrown(crown);
    takesCavity(inlay);

    // @ts-expect-error a cavity context is not assignable to a crown-only stage input
    takesCrown(inlay);
    // @ts-expect-error a crown context is not assignable to a cavity-only stage input
    takesCavity(crown);

    expect(true).toBe(true);
  });
});
