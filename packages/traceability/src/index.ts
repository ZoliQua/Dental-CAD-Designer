// @dqcad/traceability — Phase 7 Task 5: the QC traceability document's
// builders (document.ts), deterministic canonical serialization, and the
// shared PDF-ready HTML renderer (render.ts) used identically by the server
// (release documents) and the client (watermarked previews) — the "no
// divergent render logic" requirement.
//
// PLACEMENT (decided Task 5): the render function needs a home BOTH
// apps/server and apps/client/src/engine may import. shared-types is
// types-only (it holds the document TYPE + JSON Schema); the server cannot
// import client engine code; the client engine cannot import server code —
// so this small leaf package (deps: shared-types + clinical-profiles'
// canonical-JSON primitive) is the honest shared home, registered in the
// lint boundary rules like every other leaf package.
//
// The schema VALIDATOR is deliberately a subpath (`@dqcad/traceability/
// validate`) — see validate.ts's module doc (keeps ajv out of the client
// bundle by construction).
export {
  CLIENT_ATTESTED_GATES_LIMITATION_CODE,
  OUTER_ENVELOPE_LIMITATION,
  ReleaseTraceabilityInputError,
  buildPreviewTraceabilityDocument,
  buildReleaseTraceabilityDocument,
  clientAttestedGatesLimitation,
  serializeTraceabilityDocument,
} from './document.ts';
export type { PreviewTraceabilityInput, ReleaseTraceabilityInput } from './document.ts';
export { escapeHtml, formatGateValue, formatMmValue, interpolate } from './format.ts';
export { TraceabilityRenderError, renderTraceabilityHtml } from './render.ts';
export type { RenderTraceabilityOptions } from './render.ts';
export { TRACEABILITY_LOCALES, TRACEABILITY_STRINGS } from './strings.ts';
export type { TraceabilityLocale, TraceabilityStringKey } from './strings.ts';
