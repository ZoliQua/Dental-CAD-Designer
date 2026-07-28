// packages/cad-pipeline/src/pipeline/context.guardrails.test.ts
//
// Phase 5 Task 1: proves the restoration-type guard rails (context.ts) — both
// the COMPILE-TIME narrowings (a stage typed for one restoration family cannot
// be handed a context of another) and the RUNTIME guards (`assertCrownContext`
// / `assertCavityContext` throw a typed error rather than letting a crown-only
// stage silently run on a cavity case).
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@dqcad/shared-types';
import type { FdiTooth } from '@dqcad/shared-types';
import {
  BridgeContextIncompleteError,
  RestorationTypeMismatchError,
  assertBridgeContext,
  assertCavityContext,
  assertCrownContext,
  type BridgePipelineContext,
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
      version: '1.3.0',
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
      inlayMarginExclusionMm: 1.3,
      onlayMarginExclusionMm: 1.8,
      frameworkMinThicknessMm: 0.5,
      ponticHygienicClearanceMm: 2.0,
      ponticRidgeLapReliefMm: 0.05,
      ponticOvateDepthMm: 1.0, veneeringSpaceMm: 1.0,
    },
    insertionAxis: axis,
    targetMesh: { contentHash: 'h', mesh: { positions: new Float64Array(), indices: new Uint32Array() } },
    marginLoops: {},
    neighbors: {},
    antagonist: null,
    stages: {},
  };
}

/** A COMPLETE bridge context (the bridge-only fields present) — 3-unit:
 * abutments 36/38 flanking pontic 37, two connector pairs. */
function makeBridgeContext(): PipelineContext {
  return {
    ...makeContext('bridge'),
    ponticSites: [37 as FdiTooth],
    gingivaMesh: null,
    unitAdjacency: [
      [36 as FdiTooth, 37 as FdiTooth],
      [37 as FdiTooth, 38 as FdiTooth],
    ],
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

describe('assertBridgeContext', () => {
  it('narrows and passes for a COMPLETE bridge context', () => {
    expect(() => assertBridgeContext(makeBridgeContext())).not.toThrow();
  });

  it.each(['crown', 'inlay', 'onlay'] as const)('throws RestorationTypeMismatchError for a %s context', (t) => {
    const ctx = makeContext(t);
    expect(() => assertBridgeContext(ctx)).toThrow(RestorationTypeMismatchError);
    expect(() => assertBridgeContext(ctx)).toThrow(/restorationType 'bridge'/);
  });

  it('throws BridgeContextIncompleteError for a bridge context missing the bridge-only fields', () => {
    const bare = makeContext('bridge'); // no ponticSites / gingivaMesh / unitAdjacency
    expect(() => assertBridgeContext(bare)).toThrow(BridgeContextIncompleteError);
    expect(() => assertBridgeContext(bare)).toThrow(/ponticSites/);
  });

  it('reports EXACTLY the missing fields (a gingivaMesh of null is present, not missing)', () => {
    const ctx: PipelineContext = { ...makeContext('bridge'), gingivaMesh: null };
    try {
      assertBridgeContext(ctx);
      throw new Error('expected assertBridgeContext to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeContextIncompleteError);
      const missing = (e as BridgeContextIncompleteError).missing;
      expect(missing).toContain('ponticSites');
      expect(missing).toContain('unitAdjacency');
      expect(missing).not.toContain('gingivaMesh'); // null is a valid present value
    }
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

  it('a bridge-only consumer rejects crown/cavity contexts and vice versa', () => {
    const takesBridge = (c: BridgePipelineContext): void => {
      void c;
    };
    const takesCrown = (c: CrownPipelineContext): void => {
      void c;
    };

    const bridge = makeBridgeContext();
    const crown = makeContext('crown');
    assertBridgeContext(bridge);
    assertCrownContext(crown);
    // After the asserts each context is accepted only by its own consumer.
    takesBridge(bridge);
    takesCrown(crown);

    // @ts-expect-error a crown context is not assignable to a bridge-only stage input
    takesBridge(crown);
    // @ts-expect-error a bridge context is not assignable to a crown-only stage input
    takesCrown(bridge);

    expect(true).toBe(true);
  });
});
