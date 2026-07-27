// packages/clinical-profiles/src/materialProfile.ts
//
// The first REAL material profile artifact (Phase 3 Task 2's brief): a
// schema-checked, checksum-verified JSON file per material (this task ships
// exactly one, `profiles/standard-zirconia.json`) — PLAN.md §3: "Material
// profiles are JSON files with a schema + checksum; changing a profile is an
// audited operation."
//
// ## Validation strategy: hand-rolled, not ajv
//
// A single, small, fixed-shape JSON document (no user-authored profiles yet —
// "material profile EDITOR" is explicitly out of THIS task's scope, Phase 8's
// per docs/plans/phase-3-margin-axis.md) does not carry its own weight for a
// full JSON-Schema engine dependency. This hand-rolled validator
// (`validateMaterialProfileShape`) checks exactly the fields this package's
// `MaterialProfile` type declares, with the numeric ranges PLAN.md §3's table
// specifies where the table gives one — see that function's inline citations.
// If a profile EDITOR (Phase 8) later needs to validate arbitrary
// user-authored JSON against a richer schema, ajv becomes the better trade
// -off THEN; revisit at that point rather than pre-optimizing now.
//
// ## Checksum: corruption detection, not a security primitive
//
// `checksum` is a SHA-256 (this package's from-scratch `sha256.ts` — see its
// module doc for why not `node:crypto`/`crypto.subtle`) over the canonical
// (`canonicalJson.ts`) serialization of every OTHER field in the profile.
// Its job is to catch accidental corruption (a bad merge, a hand-edit that
// forgot to re-derive the checksum, truncated/garbled JSON from a bad
// deploy) — loudly, at load time, per CLAUDE.md invariant 4's "corrupt →
// loud typed error" and this task's brief. It is NOT a cryptographic
// integrity/authenticity guarantee (no secret key, no signature) — profile
// JSON files are checked into source control and code-reviewed like any
// other file; the checksum's threat model is "did this file get mangled",
// not "was this file tampered with by an adversary".
import type { RestorationParams } from '@dqcad/shared-types';
import { canonicalStringify } from './canonicalJson.ts';
import { sha256HexOfString } from './sha256.ts';

/** Bridge connector cross-section targets (mm²) — PLAN.md §3: "Bridge
 * connector cross-section — posterior: 9 mm² (7–16 mm² range, zirconia
 * default); anterior: 7 mm² (no PLAN-specified range)." Consumed starting
 * Phase 6 (bridge connector sizing) — carried on the profile now so the
 * artifact is complete from its first version, per this task's brief
 * ("bridge fields — in the profile now, consumed Phase 6"). */
export interface ConnectorAreaTargets {
  posteriorMm2: number;
  anteriorMm2: number;
}

/** A single versioned, checksum-verified material profile. */
export interface MaterialProfile {
  /** Matches `CaseSettings.materialProfileId` (shared-types) once a case
   * selects this profile. */
  id: string;
  /** Matches `CaseSettings.profileVersion` (shared-types). Semver-shaped;
   * bump on ANY value change (PLAN.md §3: "changing a profile is an audited
   * operation" — this package has no changelog mechanism of its own yet, so
   * for now a version bump + the checksum naturally changing together is the
   * audit trail; a dedicated profile changelog is Phase 8 territory). */
  version: string;
  /** Human-readable display name (English; not i18n'd — PLAN.md has no
   * per-locale material-name requirement, unlike UI chrome strings). */
  label: string;
  /** The 6-field `RestorationParams` this profile supplies as
   * `DEFAULT_RESTORATION_PARAMS` (constants.ts) — see PLAN.md §3's table for
   * each field's citation, repeated on `RAW_STANDARD_ZIRCONIA_PROFILE_JSON`'s
   * own inline comments (profiles/standard-zirconia.json has no comment
   * syntax, so the citations live here instead, keyed by field name). */
  restorationParams: RestorationParams;
  connectorAreaMm2: ConnectorAreaTargets;
  /** PLAN.md §3: "Undercut blockout threshold: 0 µm default, relative to
   * insertion axis." Consumed by Phase 3 Task 9's already-built undercut
   * scan (packages/kernel/src/axis/) once a per-restoration blockout step
   * exists — not wired to anything yet this task (YAGNI: "no axis work").*/
  undercutBlockoutThresholdMm: number;
  /**
   * Phase 4 Task 1: the OCCLUSAL minimum wall thickness (mm) — a SEPARATE
   * value from `restorationParams.minWallThicknessMm`, which this profile
   * treats as the AXIAL minimum (PLAN.md §3's table gives ONE number per
   * material for zirconia — "Monolithic; framework 0.5" — because zirconia's
   * axial and occlusal minimums coincide; e.max/lithium disilicate does NOT:
   * "1.0 mm occlusal / 0.8 mm axial", per PLAN.md §3's "Min wall thickness —
   * lithium disilicate (e.max)" row). Required (not derived/defaulted from
   * `minWallThicknessMm`) so every profile states its own occlusal minimum
   * explicitly — the future `minWallThicknessGate` (Phase 4 Task 7) reads
   * this field for occlusal-region triangles and `restorationParams.
   * minWallThicknessMm` for axial-region ones, per-material, with no silent
   * fallback either way.
   */
  occlusalMinWallThicknessMm: number;
  /**
   * PLAN.md §3: "Export max chord deviation | 5 µm | 1–20 µm | If
   * retessellation is applied." — the maximum allowed deviation (mm) between
   * a retessellated export mesh and the design surface it approximates.
   * Material-independent in PLAN's table (an export/retessellation
   * tolerance, not a clinical-material property) but carried on the profile
   * anyway per this task's brief, so the value is versioned/checksummed
   * alongside every other clinical parameter rather than hardcoded at a
   * future export call site (CLAUDE.md invariant 7).
   */
  maxChordDeviationMm: number;
  /**
   * Phase 5 Task 1: minimum material thickness (mm) for an INLAY at the
   * occlusal isthmus / pulpal floor — the thinnest cross-section the inlay
   * thickness gate (Phase 5 Task 6) allows before BLOCKING export.
   *
   * Source (e.max / lithium disilicate): Ivoclar IPS e.max IFU — a minimum
   * of 1.0 mm at the isthmus/occlusal for inlay/onlay restorations.
   * Source (zirconia): monolithic-zirconia norm of 0.5 mm minimum (the same
   * value zirconia uses for `restorationParams.minWallThicknessMm`, its
   * single monolithic minimum — PLAN.md §3 "Monolithic; framework 0.5"). Not
   * derived from `minWallThicknessMm` (an inlay has no axial crown wall — the
   * relevant minimum is the isthmus/floor), so every profile states it
   * explicitly with no silent fallback.
   */
  inlayMinThicknessMm: number;
  /**
   * Phase 5 Task 1: minimum material thickness (mm) for an ONLAY at the
   * isthmus / pulpal floor (the non-cusp-coverage regions) — the onlay
   * counterpart of `inlayMinThicknessMm`, read by the thickness gate when the
   * restoration type is `'onlay'` (Phase 5 Task 7).
   *
   * Source (e.max): Ivoclar IPS e.max IFU — 1.0 mm minimum at the
   * isthmus/occlusal (same isthmus minimum as the inlay case; the ADDED
   * requirement an onlay carries is `cuspCoverageMinThicknessMm` over the
   * covered cusps). Source (zirconia): 0.5 mm monolithic-zirconia norm.
   */
  onlayMinThicknessMm: number;
  /**
   * Phase 5 Task 1: minimum material thickness (mm) over a COVERED CUSP of an
   * onlay — the reduced-cusp occlusal coverage must be at least this thick
   * (Phase 5 Task 7's cusp-coverage thickness rule, a stricter minimum than
   * the isthmus `onlayMinThicknessMm` because a covered cusp bears full
   * occlusal load).
   *
   * Source (e.max): Ivoclar IPS e.max IFU partial-coverage guidance — 1.5 mm
   * minimum over occlusal cusp coverage. Source (zirconia): 0.7 mm documented
   * monolithic-zirconia partial-coverage norm.
   */
  cuspCoverageMinThicknessMm: number;
  /**
   * Phase 5 Task 1 (Phase 4 carry-in): the marginal feather-band width (mm)
   * the minimum-wall-thickness gate EXCLUDES from its measurement — the ring
   * of near-margin surface where a restoration legitimately thins toward the
   * finish line for the marginal seal (wall → 0 at the very margin, by
   * design, not a defect). Samples within this distance of the confirmed
   * margin loop are dropped before the gate takes its minimum, so the gate
   * measures the restoration BODY, not the seal sliver.
   *
   * Source: not a clinical-material IFU value but a QC-measurement parameter,
   * moved here (0.2 mm) from a per-call test constant per docs/demos/phase-4.md's
   * open item ("wire `marginExclusionMm` into the live `runQc` call, sourced
   * from the material profile") and the Phase 4 Task 12b feather-band
   * rationale (the min-wall gate measures the crown/inlay body; the marginal
   * band feathering to the finish line is excluded, never a weakened
   * threshold). Carried on the profile so the value is versioned/checksummed
   * with every other parameter rather than hardcoded at a call site
   * (CLAUDE.md invariant 7). Consumed by the live `runQc` path in Phase 5
   * Task 8.
   */
  marginExclusionMm: number;
  /**
   * Phase 6 Task 1 (P5 carry-in): the INLAY marginal-transition band width (mm)
   * the cavity min-wall gate EXCLUDES — the inlay analogue of the crown
   * `marginExclusionMm` feather, but sized for the cavity's much larger
   * cavosurface CONVERGENCE WEDGE (an inlay closes along its ENTIRE cavity
   * outline, not a single cervical margin, so the fit-surface ↔ occlusal-patch
   * convergence wedge wraps the whole perimeter and is ~one restoration
   * thickness wide, NOT the crown's 0.2 mm finish-line feather).
   *
   * Source: NOT a clinical-material IFU value — a GEOMETRY-DERIVED QC-measurement
   * band, promoted here (1.3 mm) from the Phase 5 Task 8 engine constant
   * (`cavityMarginExclusionMm`) per the Phase 5 carry-in. Phase 5 Task 6
   * derivation (measured on the MOD fixture): the fit↔patch global minimum is
   * always the convergence wedge (≈0.88 µm/µm from the outline), so the band must
   * clear it — below ~1.2 mm the wedge leaks in and confounds the structural
   * measurement; above ~1.5 mm the shallow-cavity variant over-excludes to 0
   * samples. 1.3 is the measured separator, pinned by the inlay-shell-acceptance
   * golden. Material-INDEPENDENT (a geometry band, not a material property) — both
   * profiles carry the same value; carried on the profile so it is
   * versioned/checksummed rather than hardcoded at the call site (invariant 7).
   */
  inlayMarginExclusionMm: number;
  /**
   * Phase 6 Task 1 (P5 carry-in): the ONLAY marginal-transition band width (mm)
   * the cavity min-wall gate excludes — wider than the inlay band because the
   * broad covered cusp's convergence wedge is wider.
   *
   * Source: geometry-derived, promoted (1.8 mm) from the Phase 5 Task 8 engine
   * constant. Phase 5 Task 7 derivation: below ~1.6 mm the wedge leaks into the
   * region-scoped coverage minimum and confounds the healthy/thin cusp-coverage
   * separation. 1.8 is the measured separator, pinned by the onlay-acceptance
   * golden. Material-independent (both profiles carry the same value).
   */
  onlayMarginExclusionMm: number;
  /**
   * Phase 6 Task 1: minimum framework (coping/substructure) wall thickness (mm)
   * for a bridge/crown FRAMEWORK (cutback for veneering) — the thickness gate
   * switches to this in framework mode (Phase 6 Task 5); consumed starting
   * Phase 6.
   *
   * Source (zirconia): PLAN.md §3 "Min wall thickness — zirconia | 0.5 mm |
   * ≥ 0.4 mm | Monolithic; framework 0.5" — the framework minimum coincides with
   * zirconia's monolithic minimum at 0.5 mm. Source (e.max / lithium disilicate):
   * e.max is predominantly a MONOLITHIC / full-contour (or pressed-and-layered)
   * material; a veneering-framework minimum is not an IFU-standard the way it is
   * for a zirconia framework. Documented placeholder = the e.max occlusal minimum
   * (1.0 mm, Ivoclar IPS e.max IFU) pending a genuine framework figure — the
   * gate binds the CONFIGURED value, and e.max long-span frameworks are a
   * reviewer/clinical-caveat item, not a silently-invented number.
   */
  frameworkMinThicknessMm: number;
  /**
   * Phase 6 Task 1: HYGIENIC (sanitary) pontic gingival clearance (mm) — the
   * cleansable air gap a hygienic pontic holds above the edentulous ridge
   * (Phase 6 Task 3's hygienic interface; the ±20 µm acceptance binds the
   * geometry to THIS configured value).
   *
   * Source: documented clinical PLACEHOLDER (per the P4 e.max-honesty precedent —
   * PLAN.md §3 has no pontic-interface row). A hygienic/sanitary pontic leaves a
   * readily cleansable space under the pontic; ~2.0 mm is a common clinical
   * teaching guideline. Not an IFU/PLAN value — a configured default the
   * acceptance measures against; revisit with a cited source if one becomes
   * available.
   */
  ponticHygienicClearanceMm: number;
  /**
   * Phase 6 Task 1: MODIFIED RIDGE-LAP pontic lingual relief (mm) — the light
   * lingual/undersurface relief a modified ridge-lap pontic holds off the ridge
   * (buccal contact, lingual relief for cleansability; Phase 6 Task 3).
   *
   * Source: documented clinical PLACEHOLDER. A modified ridge-lap pontic contacts
   * the ridge only on the buccal for esthetics and relieves the lingual to stay
   * cleansable; ~0.05 mm (light relief) is a configured default. Not an IFU/PLAN
   * value — the acceptance binds the configured value.
   */
  ponticRidgeLapReliefMm: number;
  /**
   * Phase 6 Task 1: OVATE pontic penetration depth (mm) — the controlled depth an
   * ovate pontic seats into a surgically/prosthetically prepared ridge concavity
   * (socket) (Phase 6 Task 3).
   *
   * Source: documented clinical PLACEHOLDER. An ovate pontic seats into a shallow
   * ridge concavity for an emergence-profile esthetic; ~1.0 mm is a configured
   * default depth. Not an IFU/PLAN value — the acceptance binds the configured
   * value.
   */
  ponticOvateDepthMm: number;
  /**
   * Phase 6 Task 5: the VENEERING SPACE (mm) — the depth the unit's OUTER
   * (anatomic) surface is offset inward in FRAMEWORK mode to leave room for
   * hand-layered veneering ceramic (the "cutback"). Consumed by the Phase 6
   * Task 5 framework-cutback op + stage; irrelevant in full-contour mode.
   *
   * Source: documented clinical PLACEHOLDER (the P4 e.max-honesty precedent —
   * PLAN.md §3 has no veneering-space row). Classic hand-layering leaves
   * ~0.8–1.5 mm of space for the veneering porcelain over a coping/framework;
   * 1.0 mm is a common mid-range teaching default (both materials carry the
   * same placeholder — the cutback op binds the CONFIGURED value, so a
   * documented default is acceptable; revisit with a cited source). NOTE the
   * design tension surfaced in Task 5: this is the FULL cutback depth reached
   * on the free anatomic surface only — the cutback TAPERS to zero across a
   * thin band approaching the margin (to preserve the marginal seal), so the
   * veneering space is by definition NOT uniform in that near-margin band.
   */
  veneeringSpaceMm: number;
  /** SHA-256 hex of `canonicalStringify` over every OTHER field of this
   * object — see this module's top doc. */
  checksum: string;
}

/** The on-disk JSON shape BEFORE validation — identical fields to
 * `MaterialProfile`, but `unknown`-typed until `validateMaterialProfileShape`
 * has actually checked them (never trust a `JSON.parse`/bundled-JSON-import
 * result's shape without checking — the whole point of this module). */
export type RawMaterialProfileJson = Record<string, unknown>;

/** Thrown by `loadMaterialProfile` for ANY validation failure (missing/
 * wrong-type/out-of-range field, or a checksum mismatch) — CLAUDE.md
 * invariant 4's "corrupt → loud typed error", never a silent fallback to
 * some hardcoded default. */
export class MaterialProfileValidationError extends Error {
  constructor(message: string) {
    super(`MaterialProfileValidationError: ${message}`);
    this.name = 'MaterialProfileValidationError';
  }
}

function fail(message: string): never {
  throw new MaterialProfileValidationError(message);
}

function requireFiniteNumber(value: unknown, fieldPath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${fieldPath} must be a finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireRange(
  value: number,
  fieldPath: string,
  min: number,
  max: number,
  source = 'PLAN.md §3',
): number {
  if (value < min || value > max) {
    fail(`${fieldPath} must be within [${min}, ${max}] mm (${source}), got ${value}`);
  }
  return value;
}

function requireString(value: unknown, fieldPath: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${fieldPath} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireObject(value: unknown, fieldPath: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${fieldPath} must be an object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

/**
 * Structurally validates `raw` against `MaterialProfile`'s shape, enforcing
 * PLAN.md §3's numeric ranges where the table specifies one. Does NOT check
 * the checksum (that's `loadMaterialProfile`'s job, layered on top — keeping
 * "is this shaped right" and "is this content intact" as two independently
 * testable failure modes, per this task's brief: "profile JSON schema
 * validation test (corrupt profile → loud error)" is really two tests: a
 * shape-corruption test and a checksum-tamper test).
 */
export function validateMaterialProfileShape(raw: unknown): MaterialProfile {
  const root = requireObject(raw, 'profile');

  const id = requireString(root['id'], 'profile.id');
  const version = requireString(root['version'], 'profile.version');
  const label = requireString(root['label'], 'profile.label');
  const checksum = requireString(root['checksum'], 'profile.checksum');
  if (!/^[0-9a-f]{64}$/.test(checksum)) {
    fail(
      `profile.checksum must be a lowercase 64-hex-char SHA-256 digest, got ${JSON.stringify(checksum)}`,
    );
  }

  const rp = requireObject(root['restorationParams'], 'profile.restorationParams');
  const restorationParams: RestorationParams = {
    // PLAN.md §3: "Cement gap (spacer): 50 µm default, 20–120 µm range."
    cementGapMm: requireRange(
      requireFiniteNumber(rp['cementGapMm'], 'profile.restorationParams.cementGapMm'),
      'profile.restorationParams.cementGapMm',
      0.02,
      0.12,
    ),
    // PLAN.md §3: "Marginal gap (at margin line): 20 µm default, 0–50 µm range."
    marginalGapMm: requireRange(
      requireFiniteNumber(rp['marginalGapMm'], 'profile.restorationParams.marginalGapMm'),
      'profile.restorationParams.marginalGapMm',
      0,
      0.05,
    ),
    // PLAN.md §3: spacer "Starts 0.5–1.0 mm above margin."
    spacerStartMm: requireRange(
      requireFiniteNumber(rp['spacerStartMm'], 'profile.restorationParams.spacerStartMm'),
      'profile.restorationParams.spacerStartMm',
      0.5,
      1.0,
    ),
    // PLAN.md §3: "Min wall thickness — zirconia: 0.5 mm default, ≥ 0.4 mm."
    // No stated upper bound; 5 mm is a generous sanity ceiling (a real wall
    // is never anywhere near this — catches an obviously-corrupt value, e.g.
    // units confusion, without inventing a PLAN-unspecified clinical limit).
    minWallThicknessMm: requireRange(
      requireFiniteNumber(rp['minWallThicknessMm'], 'profile.restorationParams.minWallThicknessMm'),
      'profile.restorationParams.minWallThicknessMm',
      0.4,
      5,
    ),
    // PLAN.md §3: "Proximal contact penetration: +20 µm default, −50…+100 µm range."
    proximalContactPenetrationMm: requireRange(
      requireFiniteNumber(
        rp['proximalContactPenetrationMm'],
        'profile.restorationParams.proximalContactPenetrationMm',
      ),
      'profile.restorationParams.proximalContactPenetrationMm',
      -0.05,
      0.1,
    ),
    // PLAN.md §3: "Occlusal contact: 0 µm default, −200…+100 µm range."
    occlusalContactMm: requireRange(
      requireFiniteNumber(rp['occlusalContactMm'], 'profile.restorationParams.occlusalContactMm'),
      'profile.restorationParams.occlusalContactMm',
      -0.2,
      0.1,
    ),
  };

  const connector = requireObject(root['connectorAreaMm2'], 'profile.connectorAreaMm2');
  const connectorAreaMm2: ConnectorAreaTargets = {
    // PLAN.md §3: "Bridge connector cross-section — posterior: 9 mm², 7–16 mm² range."
    posteriorMm2: requireRange(
      requireFiniteNumber(connector['posteriorMm2'], 'profile.connectorAreaMm2.posteriorMm2'),
      'profile.connectorAreaMm2.posteriorMm2',
      7,
      16,
    ),
    // PLAN.md §3: "Bridge connector cross-section — anterior: 7 mm²." No
    // range given in the table ("—") — only a positive-finite sanity bound
    // is enforced (see `requireFiniteNumber` above); an explicit generous
    // ceiling (16 mm², same as posterior's stated upper bound — anterior
    // connectors are clinically always smaller, never larger) guards against
    // an obviously-corrupt value without inventing an un-cited clinical
    // limit.
    anteriorMm2: requireRange(
      requireFiniteNumber(connector['anteriorMm2'], 'profile.connectorAreaMm2.anteriorMm2'),
      'profile.connectorAreaMm2.anteriorMm2',
      0.1,
      16,
    ),
  };

  // PLAN.md §3: "Undercut blockout threshold: 0 µm default." No range given
  // — only finiteness is enforced.
  const undercutBlockoutThresholdMm = requireFiniteNumber(
    root['undercutBlockoutThresholdMm'],
    'profile.undercutBlockoutThresholdMm',
  );

  // PLAN.md §3: "Min wall thickness — lithium disilicate (e.max): 1.0 mm
  // occlusal / 0.8 mm axial." No stated lower bound for the occlusal value;
  // floored at 0.3mm (PLAN's OWN lowest stated minimum across every
  // material row, "Min wall thickness — metal: 0.3 mm") rather than an
  // uncited clinical judgment, ceilinged at 5mm matching
  // restorationParams.minWallThicknessMm's own sanity ceiling.
  const occlusalMinWallThicknessMm = requireRange(
    requireFiniteNumber(root['occlusalMinWallThicknessMm'], 'profile.occlusalMinWallThicknessMm'),
    'profile.occlusalMinWallThicknessMm',
    0.3,
    5,
  );

  // PLAN.md §3: "Export max chord deviation: 5 µm default, 1–20 µm range."
  const maxChordDeviationMm = requireRange(
    requireFiniteNumber(root['maxChordDeviationMm'], 'profile.maxChordDeviationMm'),
    'profile.maxChordDeviationMm',
    0.001,
    0.02,
  );

  // Phase 5 Task 1: inlay/onlay thickness minimums (IFU / documented norms —
  // see each field's TSDoc on `MaterialProfile`). Floored at 0.3 mm (PLAN.md
  // §3's lowest stated minimum across every material row, "Min wall thickness
  // — metal: 0.3 mm") and ceilinged at 5 mm (matching
  // restorationParams.minWallThicknessMm's own sanity ceiling) — a generous
  // corruption guard, not an invented clinical limit.
  const inlayMinThicknessMm = requireRange(
    requireFiniteNumber(root['inlayMinThicknessMm'], 'profile.inlayMinThicknessMm'),
    'profile.inlayMinThicknessMm',
    0.3,
    5,
    'e.max IFU 1.0 / zirconia 0.5 norm',
  );
  const onlayMinThicknessMm = requireRange(
    requireFiniteNumber(root['onlayMinThicknessMm'], 'profile.onlayMinThicknessMm'),
    'profile.onlayMinThicknessMm',
    0.3,
    5,
    'e.max IFU 1.0 / zirconia 0.5 norm',
  );
  const cuspCoverageMinThicknessMm = requireRange(
    requireFiniteNumber(root['cuspCoverageMinThicknessMm'], 'profile.cuspCoverageMinThicknessMm'),
    'profile.cuspCoverageMinThicknessMm',
    0.3,
    5,
    'e.max IFU 1.5 / zirconia 0.7 norm',
  );

  // Phase 5 Task 1 (Phase 4 carry-in): marginal feather-band exclusion width
  // (mm). 0 (no exclusion) is valid; ceilinged at 1.0 mm — a feather band
  // wider than that would exclude clinically-load-bearing body, not just the
  // seal sliver. Not a PLAN §3 clinical value (a QC-measurement parameter —
  // see the field's TSDoc), hence the docs/demos/phase-4.md source note.
  const marginExclusionMm = requireRange(
    requireFiniteNumber(root['marginExclusionMm'], 'profile.marginExclusionMm'),
    'profile.marginExclusionMm',
    0,
    1.0,
    'docs/demos/phase-4.md feather-band carry-in',
  );

  // Phase 6 Task 1 (P5 carry-in): the cavity marginal-transition bands, promoted
  // from the engine constant (`cavityMarginExclusionMm`). Geometry-derived
  // QC-measurement bands (~one restoration thickness wide), NOT the crown feather
  // — so a higher ceiling (3.0 mm) than `marginExclusionMm`'s 1.0 mm; floored at 0
  // (no exclusion is a valid choice). Source: Phase 5 Task 6/7 derivations (see
  // each field's TSDoc).
  const inlayMarginExclusionMm = requireRange(
    requireFiniteNumber(root['inlayMarginExclusionMm'], 'profile.inlayMarginExclusionMm'),
    'profile.inlayMarginExclusionMm',
    0,
    3.0,
    'P5 T6 convergence-wedge derivation',
  );
  const onlayMarginExclusionMm = requireRange(
    requireFiniteNumber(root['onlayMarginExclusionMm'], 'profile.onlayMarginExclusionMm'),
    'profile.onlayMarginExclusionMm',
    0,
    3.0,
    'P5 T7 convergence-wedge derivation',
  );

  // Phase 6 Task 1: bridge/pontic/framework fields (see each field's TSDoc).
  // frameworkMinThicknessMm floored/ceilinged like the other thickness minimums
  // (PLAN.md §3's lowest 0.3 mm / the 5 mm sanity ceiling).
  const frameworkMinThicknessMm = requireRange(
    requireFiniteNumber(root['frameworkMinThicknessMm'], 'profile.frameworkMinThicknessMm'),
    'profile.frameworkMinThicknessMm',
    0.3,
    5,
    'PLAN.md §3 zirconia framework 0.5 / e.max IFU 1.0 placeholder',
  );
  // Pontic interface params — documented clinical placeholders (the ±20 µm
  // acceptance binds the CONFIGURED value). Generous sanity ranges guard against
  // an obviously-corrupt value without inventing a cited clinical limit.
  const ponticHygienicClearanceMm = requireRange(
    requireFiniteNumber(root['ponticHygienicClearanceMm'], 'profile.ponticHygienicClearanceMm'),
    'profile.ponticHygienicClearanceMm',
    0,
    5,
    'documented clinical placeholder (hygienic clearance)',
  );
  const ponticRidgeLapReliefMm = requireRange(
    requireFiniteNumber(root['ponticRidgeLapReliefMm'], 'profile.ponticRidgeLapReliefMm'),
    'profile.ponticRidgeLapReliefMm',
    0,
    1,
    'documented clinical placeholder (ridge-lap relief)',
  );
  const ponticOvateDepthMm = requireRange(
    requireFiniteNumber(root['ponticOvateDepthMm'], 'profile.ponticOvateDepthMm'),
    'profile.ponticOvateDepthMm',
    0,
    5,
    'documented clinical placeholder (ovate depth)',
  );
  // Phase 6 Task 5: the veneering-space cutback depth (mm). Floored at 0 (no
  // cutback is a valid, if degenerate, choice), ceilinged at 2.0 mm — a
  // veneering space above ~1.5 mm is already atypical, 2.0 is a generous
  // corruption guard rather than an invented clinical limit. Documented
  // placeholder (see the field's TSDoc).
  const veneeringSpaceMm = requireRange(
    requireFiniteNumber(root['veneeringSpaceMm'], 'profile.veneeringSpaceMm'),
    'profile.veneeringSpaceMm',
    0,
    2.0,
    'documented clinical placeholder (hand-layering veneering space 0.8–1.5 mm)',
  );

  const allowedKeys = new Set([
    'id',
    'version',
    'label',
    'restorationParams',
    'connectorAreaMm2',
    'undercutBlockoutThresholdMm',
    'occlusalMinWallThicknessMm',
    'maxChordDeviationMm',
    'inlayMinThicknessMm',
    'onlayMinThicknessMm',
    'cuspCoverageMinThicknessMm',
    'marginExclusionMm',
    'inlayMarginExclusionMm',
    'onlayMarginExclusionMm',
    'frameworkMinThicknessMm',
    'ponticHygienicClearanceMm',
    'ponticRidgeLapReliefMm',
    'ponticOvateDepthMm',
    'veneeringSpaceMm',
    'checksum',
  ]);
  for (const key of Object.keys(root)) {
    if (!allowedKeys.has(key)) {
      fail(`profile has an unrecognized field ${JSON.stringify(key)}`);
    }
  }

  return {
    id,
    version,
    label,
    restorationParams,
    connectorAreaMm2,
    undercutBlockoutThresholdMm,
    occlusalMinWallThicknessMm,
    maxChordDeviationMm,
    inlayMinThicknessMm,
    onlayMinThicknessMm,
    cuspCoverageMinThicknessMm,
    marginExclusionMm,
    inlayMarginExclusionMm,
    onlayMarginExclusionMm,
    frameworkMinThicknessMm,
    ponticHygienicClearanceMm,
    ponticRidgeLapReliefMm,
    ponticOvateDepthMm,
    veneeringSpaceMm,
    checksum,
  };
}

/** Recomputes the checksum a validated profile SHOULD have — every field
 * except `checksum` itself, canonically serialized. */
export function computeProfileChecksum(profile: Omit<MaterialProfile, 'checksum'>): string {
  return sha256HexOfString(canonicalStringify(profile));
}

/**
 * Validates `raw`'s shape (`validateMaterialProfileShape`) AND its checksum
 * — the full "loud, typed error on any corruption" contract this task's
 * brief asks for. Synchronous and side-effect-free: safe to call at module
 * top level (this package's `index.ts` does exactly that for
 * `STANDARD_ZIRCONIA_PROFILE`, satisfying "loaded/validated at startup" —
 * any module that imports this package transitively runs this check
 * immediately, before the profile value can ever be read).
 *
 * @throws {MaterialProfileValidationError} on any shape or checksum failure.
 */
export function loadMaterialProfile(raw: unknown): MaterialProfile {
  const profile = validateMaterialProfileShape(raw);
  const { checksum, ...rest } = profile;
  const expected = computeProfileChecksum(rest);
  if (checksum !== expected) {
    fail(
      `profile "${profile.id}" failed checksum verification (recorded ${checksum}, recomputed ${expected}) — ` +
        'the profile JSON was corrupted or hand-edited without re-deriving its checksum.',
    );
  }
  return Object.freeze({
    ...profile,
    restorationParams: Object.freeze({ ...profile.restorationParams }),
    connectorAreaMm2: Object.freeze({ ...profile.connectorAreaMm2 }),
  });
}
