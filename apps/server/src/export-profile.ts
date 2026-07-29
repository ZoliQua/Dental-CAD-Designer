// apps/server/src/export-profile.ts
//
// Phase 7 Task 4 fix round (review F1) — server-side MATERIAL-PROFILE PINNING
// for the export release gate.
//
// The review demonstrated the exploit this module closes: gate thresholds
// used to ride raw and unbounded in `qcContext`, so a request could ship
// `minWallThicknessMm: 0.05` (+ a matching client report) and RELEASE a crown
// with a real 295 µm wall — `passed: true`, unacknowledged, the loosening
// invisible in the ledger. That is the "silently bypassed" / "weaken a gate
// threshold" case CLAUDE.md invariant 4 forbids, at the one boundary where it
// matters most (the file a mill receives).
//
// Closure: thresholds — unlike dies/surfaces/margins — HAVE an authoritative
// server-side source: `@dqcad/clinical-profiles`, keyed by id+version and
// pinned by a canonical-JSON checksum. The route therefore
//   1. RESOLVES the profile named by `request.materialProfile.{id,version}`
//      from the shipped registry (unknown id/version → 409
//      `export-material-profile-unknown`),
//   2. VERIFIES `request.materialProfile.checksum` equals the resolved
//      profile's checksum (mismatch → 409
//      `export-material-profile-checksum-mismatch` — the checksum is no
//      longer inert), and
//   3. VERIFIES every profile-derived constant riding in `qcContext` equals
//      the value the resolved profile dictates under the CLIENT ENGINES' OWN
//      resolution rules (documented per field below) — any divergence → 409
//      `export-profile-threshold-mismatch` naming every offending field with
//      both values. Divergence is REFUSED, never silently substituted: the
//      client must learn its thresholds were wrong (a silent substitution
//      would guarantee a confusing downstream qc-mismatch instead).
// Because equality is enforced, feeding the riding values into the QC run IS
// running with server-resolved thresholds — with zero absent-optional-field
// semantic drift. The free tolerance knobs with no profile source
// (marginFit/seating/contact/seamDihedral/relief-threshold overrides) are
// schema-FORBIDDEN in the export contexts entirely (schemas.ts,
// EXPORT_CONTEXT_FORBIDDEN_KNOBS) — both sides then use the cad-pipeline
// gate defaults identically.
//
// ## Per-field authority map (mirrors the client engines EXACTLY)
//
// crown (apps/client/src/engine/crownDesign.ts buildQcPayload):
//   minWallThicknessMm          ← restoration.params.minWallThicknessMm — the
//                                 SAVED, schema-bounded ([0.4, 5] mm, PLAN.md
//                                 §3 via putCaseBodySchema) user parameter the
//                                 client session runs QC with. Dual
//                                 containment: the saved value cannot leave
//                                 the clinical range (PUT rejects it), and
//                                 the riding value must equal the saved one.
//   occlusalMinWallThicknessMm  ← profile.occlusalMinWallThicknessMm
//   connectorAreaTargetMm2      ← profile.connectorAreaMm2.anteriorMm2 (the
//                                 client rule today — single crowns feed the
//                                 N/A connector stub with the anterior target)
//   marginExclusionMm (opt)     ← profile.marginExclusionMm
// inlay/onlay (cavityDesign.ts):
//   thicknessMinimums           ← { profile.inlayMinThicknessMm,
//                                   profile.onlayMinThicknessMm }
//   marginExclusionMm           ← type-branched band: onlay →
//                                 profile.onlayMarginExclusionMm, inlay →
//                                 profile.inlayMarginExclusionMm
//   coverage.cuspCoverageMinThicknessMm (opt) ← profile.cuspCoverageMinThicknessMm
// bridge (bridgeDesign.ts):
//   minWallThicknessMm          ← profile.restorationParams.minWallThicknessMm
//   occlusalMinWallThicknessMm  ← profile.occlusalMinWallThicknessMm
//   connectorAreaTargetMm2      ← profile.connectorAreaMm2.posteriorMm2
//   frameworkMinThicknessMm(opt)← profile.frameworkMinThicknessMm
//   connectors[i].targetMm2(opt)← connectorPositionalTargetMm2(teeth, profile
//                                 .connectorAreaMm2) — the FDI positional rule
//                                 (requires the connector's 2 teeth to ride)
//   ponticRelief.configuredReliefMm ← by style: hygienic →
//                                 ponticHygienicClearanceMm, ridgeLap/
//                                 modifiedRidgeLap → ponticRidgeLapReliefMm,
//                                 ovate → ponticOvateDepthMm (unknown style →
//                                 unverifiable → refused)
//   (connectors[i].minAreaMm2 and ponticRelief.maxAbsDeviationMm are
//   MEASURED values — geometry-scoped, they legitimately ride.)
//
// If a client engine's resolution rule ever changes (e.g. a posterior crown
// starts using posteriorMm2), this map must change WITH it — the pass-proof
// suites fail loudly on any drift (a legitimate export starts 409ing).
import {
  EMAX_LITHIUM_DISILICATE_PROFILE,
  STANDARD_ZIRCONIA_PROFILE,
  type MaterialProfile,
} from '@dqcad/clinical-profiles';
import { connectorPositionalTargetMm2 } from '@dqcad/cad-pipeline';
import type { FdiTooth, Restoration, RestorationExportRequest } from '@dqcad/shared-types';
import { ExportRejectionError } from './export-validation.js';
import type {
  BridgeExportQcContext,
  CrownExportQcContext,
  ExportQcContext,
  InlayExportQcContext,
} from './export-route.js';

/** The shipped profile registry — every profile `@dqcad/clinical-profiles`
 * loads (and checksum-validates) at import time. */
export const KNOWN_MATERIAL_PROFILES: readonly MaterialProfile[] = [
  STANDARD_ZIRCONIA_PROFILE,
  EMAX_LITHIUM_DISILICATE_PROFILE,
];

/**
 * Resolves `request.materialProfile` against the shipped registry and
 * verifies its checksum — steps 1+2 of this module's doc.
 *
 * @throws {ExportRejectionError} `export-material-profile-unknown` /
 *   `export-material-profile-checksum-mismatch` (both 409).
 */
export function resolveExportMaterialProfile(
  identity: RestorationExportRequest['materialProfile'],
): MaterialProfile {
  const profile = KNOWN_MATERIAL_PROFILES.find((p) => p.id === identity.id && p.version === identity.version);
  if (!profile) {
    throw new ExportRejectionError(
      'export-material-profile-unknown',
      409,
      `no material profile ${identity.id}@${identity.version} is known to this server — ` +
        'the export cannot be certified against an unresolvable parameter set',
      {
        requested: { id: identity.id, version: identity.version },
        known: KNOWN_MATERIAL_PROFILES.map((p) => ({ id: p.id, version: p.version })),
      },
    );
  }
  if (identity.checksum !== profile.checksum) {
    throw new ExportRejectionError(
      'export-material-profile-checksum-mismatch',
      409,
      `the request's checksum for ${identity.id}@${identity.version} does not match the server's ` +
        'validated profile — the client designed against a different parameter set',
      { requestChecksum: identity.checksum, resolvedChecksum: profile.checksum },
    );
  }
  return profile;
}

interface ThresholdMismatch {
  field: string;
  riding: unknown;
  resolved: unknown;
}

/** Records a mismatch when a riding value differs from its resolved
 * authority. `undefined` riding values are skipped — an absent OPTIONAL field
 * means both sides use the gate's own default (never a loosening; see the
 * module doc's "verify-if-present" note). */
function check(mismatches: ThresholdMismatch[], field: string, riding: unknown, resolved: unknown): void {
  if (riding !== undefined && riding !== resolved) {
    mismatches.push({ field, riding, resolved });
  }
}

const PONTIC_RELIEF_BY_STYLE: Record<string, (p: MaterialProfile) => number> = {
  hygienic: (p) => p.ponticHygienicClearanceMm,
  ridgeLap: (p) => p.ponticRidgeLapReliefMm,
  modifiedRidgeLap: (p) => p.ponticRidgeLapReliefMm,
  ovate: (p) => p.ponticOvateDepthMm,
};

/**
 * Verifies every profile-derived constant in the riding `qcContext` against
 * the server-resolved profile (and, for the crown wall minimum, the saved
 * restoration parameter) — step 3 of this module's doc. Collects EVERY
 * mismatch before throwing so the diagnostic names the full set.
 *
 * @throws {ExportRejectionError} `export-profile-threshold-mismatch` (409).
 */
export function verifyProfileThresholds(
  request: RestorationExportRequest,
  qcContext: ExportQcContext,
  profile: MaterialProfile,
  restoration: Restoration,
): void {
  const mismatches: ThresholdMismatch[] = [];

  if (request.restorationType === 'crown') {
    const c = qcContext as CrownExportQcContext;
    check(mismatches, 'minWallThicknessMm', c.minWallThicknessMm, restoration.params.minWallThicknessMm);
    check(mismatches, 'occlusalMinWallThicknessMm', c.occlusalMinWallThicknessMm, profile.occlusalMinWallThicknessMm);
    check(mismatches, 'connectorAreaTargetMm2', c.connectorAreaTargetMm2, profile.connectorAreaMm2.anteriorMm2);
    check(mismatches, 'marginExclusionMm', c.marginExclusionMm, profile.marginExclusionMm);
  } else if (request.restorationType === 'inlay' || request.restorationType === 'onlay') {
    const c = qcContext as InlayExportQcContext;
    check(
      mismatches,
      'thicknessMinimums.inlayMinThicknessMm',
      c.thicknessMinimums.inlayMinThicknessMm,
      profile.inlayMinThicknessMm,
    );
    check(
      mismatches,
      'thicknessMinimums.onlayMinThicknessMm',
      c.thicknessMinimums.onlayMinThicknessMm,
      profile.onlayMinThicknessMm,
    );
    check(
      mismatches,
      'marginExclusionMm',
      c.marginExclusionMm,
      request.restorationType === 'onlay' ? profile.onlayMarginExclusionMm : profile.inlayMarginExclusionMm,
    );
    check(
      mismatches,
      'coverage.cuspCoverageMinThicknessMm',
      c.coverage?.cuspCoverageMinThicknessMm,
      profile.cuspCoverageMinThicknessMm,
    );
  } else {
    const c = qcContext as BridgeExportQcContext;
    check(mismatches, 'minWallThicknessMm', c.minWallThicknessMm, profile.restorationParams.minWallThicknessMm);
    check(mismatches, 'occlusalMinWallThicknessMm', c.occlusalMinWallThicknessMm, profile.occlusalMinWallThicknessMm);
    check(mismatches, 'connectorAreaTargetMm2', c.connectorAreaTargetMm2, profile.connectorAreaMm2.posteriorMm2);
    check(mismatches, 'frameworkMinThicknessMm', c.frameworkMinThicknessMm, profile.frameworkMinThicknessMm);
    c.connectors.forEach((connector, i) => {
      if (connector.targetMm2 === undefined) return;
      const teeth = connector.teeth;
      if (!teeth || teeth.length !== 2) {
        // A positional target without its two teeth is unverifiable — treat
        // as a mismatch against "no resolvable target".
        mismatches.push({ field: `connectors[${i}].targetMm2`, riding: connector.targetMm2, resolved: null });
        return;
      }
      check(
        mismatches,
        `connectors[${i}].targetMm2`,
        connector.targetMm2,
        // The route schema pins each entry to a real FDI code (fdiToothSchema).
        connectorPositionalTargetMm2(teeth[0] as FdiTooth, teeth[1] as FdiTooth, profile.connectorAreaMm2),
      );
    });
    const reliefOf = PONTIC_RELIEF_BY_STYLE[c.ponticRelief.style];
    if (!reliefOf) {
      mismatches.push({
        field: 'ponticRelief.style',
        riding: c.ponticRelief.style,
        resolved: Object.keys(PONTIC_RELIEF_BY_STYLE).join('|'),
      });
    } else {
      check(mismatches, 'ponticRelief.configuredReliefMm', c.ponticRelief.configuredReliefMm, reliefOf(profile));
    }
  }

  if (mismatches.length > 0) {
    throw new ExportRejectionError(
      'export-profile-threshold-mismatch',
      409,
      `${mismatches.length} riding gate threshold(s) diverge from the server-resolved material profile ` +
        `${profile.id}@${profile.version} (${mismatches.map((m) => m.field).join(', ')}) — the export is ` +
        'refused; a loosened threshold would silently bypass a release gate (invariant 4). ' +
        'Re-run QC against the correct profile values and re-export.',
      { profile: { id: profile.id, version: profile.version }, mismatches },
    );
  }
}
