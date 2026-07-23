// packages/tooth-library/src/generate/toothParams.ts
//
// PLACEHOLDER-ANATOMY dimension tables (see README.md's provenance/
// licensing-risk note, PLAN.md §9) for this task's procedural generators.
// Every millimeter figure below is a rough, textbook-average adult tooth
// dimension (the kind of ballpark figure found in any general dental
// anatomy reference — e.g. mesiodistal/labiolingual crown width and
// crown-height order-of-magnitude ranges) used ONLY to seed a plausible,
// watertight PLACEHOLDER crown shape for pipeline development. They are
// NOT sourced from a specific patient, scan, or licensed anatomical atlas,
// are NOT claimed to be clinically precise, and are REPLACEABLE — a real
// tooth-library asset (scanned/sculpted by a technician, or an openly-
// licensed anatomical set) replaces one of these generated assets by
// providing its own mesh + metadata satisfying `schema.ts`'s format; no
// pipeline code changes.
export interface IncisorTypeParams {
  crownHeightMm: number;
  rxCervicalMm: number;
  rxIncisalMm: number;
  rxContactBulgeMm: number;
  vContact: number;
  sigmaContactV: number;
  ryBuccalCervicalMm: number;
  ryBuccalIncisalMm: number;
  ryBuccalContactBulgeMm: number;
  ryLingualCervicalMm: number;
  ryLingualIncisalMm: number;
  cingulumBulgeMm: number;
  vCingulum: number;
  sigmaCingulumV: number;
  fossaDepthMm: number;
  vFossa: number;
  sigmaFossaV: number;
  lingualAngularHalfWidthRad: number;
  marginalRidgeOffsetRad: number;
}

const DEG = Math.PI / 180;

/** Maxillary central incisor (FDI 11/21) — the larger of the two incisor
 * shapes this task generates. */
export const CENTRAL_INCISOR_PARAMS: IncisorTypeParams = {
  crownHeightMm: 10.5,
  rxCervicalMm: 3.1,
  rxIncisalMm: 3.2,
  rxContactBulgeMm: 1.0,
  vContact: 0.42,
  sigmaContactV: 0.16,
  ryBuccalCervicalMm: 1.0,
  ryBuccalIncisalMm: 0.9,
  ryBuccalContactBulgeMm: 0.6,
  ryLingualCervicalMm: 0.9,
  ryLingualIncisalMm: 0.8,
  cingulumBulgeMm: 0.5,
  vCingulum: 0.14,
  sigmaCingulumV: 0.08,
  fossaDepthMm: 0.35,
  vFossa: 0.55,
  sigmaFossaV: 0.2,
  lingualAngularHalfWidthRad: 85 * DEG,
  marginalRidgeOffsetRad: 65 * DEG,
};

/** Maxillary lateral incisor (FDI 12/22) — smaller than the central, same
 * general shape family (see this module's header doc). */
export const LATERAL_INCISOR_PARAMS: IncisorTypeParams = {
  crownHeightMm: 9.0,
  rxCervicalMm: 2.3,
  rxIncisalMm: 2.4,
  rxContactBulgeMm: 0.85,
  vContact: 0.4,
  sigmaContactV: 0.16,
  ryBuccalCervicalMm: 0.85,
  ryBuccalIncisalMm: 0.75,
  ryBuccalContactBulgeMm: 0.5,
  ryLingualCervicalMm: 0.8,
  ryLingualIncisalMm: 0.7,
  cingulumBulgeMm: 0.45,
  vCingulum: 0.14,
  sigmaCingulumV: 0.08,
  fossaDepthMm: 0.3,
  vFossa: 0.55,
  sigmaFossaV: 0.2,
  lingualAngularHalfWidthRad: 85 * DEG,
  marginalRidgeOffsetRad: 65 * DEG,
};

/** FDI 12/11/21/22 -> which incisor shape family it uses (central vs
 * lateral) — the ONLY per-FDI difference (guardrail: "share the incisor
 * generator, differ by FDI-specific size params"). */
export const INCISOR_FDI_PARAMS: Readonly<Record<number, IncisorTypeParams>> = {
  11: CENTRAL_INCISOR_PARAMS,
  21: CENTRAL_INCISOR_PARAMS,
  12: LATERAL_INCISOR_PARAMS,
  22: LATERAL_INCISOR_PARAMS,
};

export interface MolarParams {
  crownHeightMm: number;
  rxCervicalMm: number;
  rxWallTopMm: number;
  rxContactBulgeMm: number;
  ryCervicalMm: number;
  ryWallTopMm: number;
  ryContactBulgeMm: number;
  vContact: number;
  sigmaContactV: number;
  occlusalTableReliefMm: number;
  cuspHeightMm: number;
  sCusp: number;
  sigmaSCusp: number;
  cuspAngularHalfWidthRad: number;
  fossaDepthMm: number;
  sigmaSFossa: number;
  ridgeHeightMm: number;
  sRidge: number;
  sigmaSRidge: number;
  ridgeAngularHalfWidthRad: number;
  radialShrinkPower: number;
}

/** Maxillary right first molar (FDI 16) — the "at least one posterior"
 * starter asset this task ships (see README.md's YAGNI note: the other 27
 * FDI codes reuse this same generator with their own future
 * `MolarParams` entry). */
export const FIRST_MOLAR_PARAMS: MolarParams = {
  crownHeightMm: 6.0,
  rxCervicalMm: 3.6,
  rxWallTopMm: 4.2,
  rxContactBulgeMm: 0.9,
  ryCervicalMm: 3.9,
  ryWallTopMm: 4.6,
  ryContactBulgeMm: 1.0,
  vContact: 0.35,
  sigmaContactV: 0.18,
  occlusalTableReliefMm: 1.0,
  cuspHeightMm: 1.6,
  sCusp: 0.55,
  sigmaSCusp: 0.22,
  cuspAngularHalfWidthRad: 35 * DEG,
  fossaDepthMm: 1.3,
  sigmaSFossa: 0.35,
  ridgeHeightMm: 0.5,
  sRidge: 0.12,
  sigmaSRidge: 0.1,
  ridgeAngularHalfWidthRad: 30 * DEG,
  radialShrinkPower: 0.85,
};

export const MOLAR_FDI_PARAMS: Readonly<Record<number, MolarParams>> = {
  16: FIRST_MOLAR_PARAMS,
};
