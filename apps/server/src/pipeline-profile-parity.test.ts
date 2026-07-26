// apps/server/src/pipeline-profile-parity.test.ts
//
// Phase 5 Task 1: guards the `PipelineMaterialProfile` (cad-pipeline) ↔
// `MaterialProfile` (clinical-profiles) MIRROR. `PipelineMaterialProfile`
// structurally duplicates `MaterialProfile` field-for-field MINUS `label` and
// `checksum` (see cad-pipeline/src/pipeline/context.ts's module doc for why it
// is a duplicated, not imported, type — the layer rule forbids
// cad-pipeline → clinical-profiles). The two therefore drift silently the
// moment someone adds a clinical field to one and forgets the other; this test
// fails loudly when they diverge.
//
// It lives in apps/server because this is the layer that legitimately imports
// BOTH packages (the export re-validation path) — cad-pipeline itself cannot
// import clinical-profiles.
import { describe, expect, it } from 'vitest';
import { STANDARD_ZIRCONIA_PROFILE, type MaterialProfile } from '@dqcad/clinical-profiles';
import type { PipelineMaterialProfile } from '@dqcad/cad-pipeline';
import { PROFILE } from './crown-qc-fixture.testutil.ts';

// The two fields a resolved MaterialProfile carries that the pipeline mirror
// deliberately omits (a display name and the artifact checksum — neither is a
// clinical value a stage/gate consumes).
const MATERIAL_ONLY_KEYS = ['label', 'checksum'] as const;

describe('PipelineMaterialProfile ↔ MaterialProfile field parity', () => {
  it('has exactly the MaterialProfile field set minus {label, checksum}', () => {
    const materialKeys = Object.keys(STANDARD_ZIRCONIA_PROFILE)
      .filter((k) => !(MATERIAL_ONLY_KEYS as readonly string[]).includes(k))
      .sort();
    const pipelineKeys = Object.keys(PROFILE).sort();
    // Fails in BOTH drift directions: a clinical field added to MaterialProfile
    // but not PipelineMaterialProfile (materialKeys gains it), or vice versa.
    expect(pipelineKeys).toEqual(materialKeys);
  });

  it('a resolved MaterialProfile constructs a PipelineMaterialProfile (compile-time mirror)', () => {
    // Compiles ONLY if every PipelineMaterialProfile field exists on
    // MaterialProfile (minus label/checksum) with a compatible type — i.e. the
    // pipeline mirror never declares a field the source type lacks.
    const mirror = (m: MaterialProfile): PipelineMaterialProfile => {
      const { label, checksum, ...rest } = m;
      void label; // intentionally dropped (the pipeline mirror omits these two)
      void checksum;
      return rest;
    };
    const p = mirror(STANDARD_ZIRCONIA_PROFILE);
    expect(p.inlayMinThicknessMm).toBe(STANDARD_ZIRCONIA_PROFILE.inlayMinThicknessMm);
    expect(p.marginExclusionMm).toBe(STANDARD_ZIRCONIA_PROFILE.marginExclusionMm);
    // Phase 6 Task 1: the promoted cavity bands + bridge/pontic/framework fields
    // mirror through too.
    expect(p.inlayMarginExclusionMm).toBe(STANDARD_ZIRCONIA_PROFILE.inlayMarginExclusionMm);
    expect(p.onlayMarginExclusionMm).toBe(STANDARD_ZIRCONIA_PROFILE.onlayMarginExclusionMm);
    expect(p.frameworkMinThicknessMm).toBe(STANDARD_ZIRCONIA_PROFILE.frameworkMinThicknessMm);
    expect(p.ponticHygienicClearanceMm).toBe(STANDARD_ZIRCONIA_PROFILE.ponticHygienicClearanceMm);
  });
});
