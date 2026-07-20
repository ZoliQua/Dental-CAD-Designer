// packages/kernel/src/margin/marginRidge.ts
//
// Phase 3 Task 4: margin ridge detection — the auto-proposal core. From a
// user-placed `seed` (a `SurfacePoint` roughly inside a crown prep, near its
// finish line), finds the concave curvature RIDGE the shoulder margin forms
// and walks it bidirectionally on the halfedge graph until the walk closes
// into a loop, then simplifies the walked vertex path into a curvature-
// adaptive `SurfacePoint[]` anchor list ready for `fitSurfaceSpline`
// (spline/surfaceSpline.ts).
//
// ## Scalar field choice: kappa2 (the SMALLER/most-negative principal
// curvature), not |kappa| or curvedness — MEASURED on the real prep
//
// A shoulder margin is a CONCAVE crease (see this file's "why concave, not
// convex" note below): the crown's axial wall meets the shoulder shelf at a
// dihedral valley, not a peak. `curvature/curvature.ts`'s `k2` (the smaller
// of the two principal curvatures, `k1 >= k2` by construction) is SIGNED and
// goes strongly NEGATIVE exactly at a concave crease — `k1`/`|k2|`/
// `curvedness = sqrt((k1^2+k2^2)/2)` are all unsigned (or, for k1, tracks
// the WRONG sign of feature) and cannot on their own distinguish a concave
// margin groove from an equally sharp but CONVEX ridge nearby (a cusp tip,
// an incisal edge, a marginal ridge, the OUTER edge of the shoulder shelf
// itself — all common on a real arch and all produce large curvature
// magnitude with the OPPOSITE sign).
//
// Measured evidence (real arch-case-01 upperjaw, tooth "11" shoulder prep —
// see this task's report for the full probe-line table and the anterior
// cluster survey that located it): sampling along a line crossing the
// margin, `k2` peaks at -37.5 mm^-1 EXACTLY at the margin crest (the closest-
// point projection lands within 0.09 mm of the true ridge vertex there), and
// decays to a -1..-5 mm^-1 background within about 1 mm on either side,
// crossing toward ~0 (occasionally slightly POSITIVE, the adjacent natural
// convex anatomy) beyond ~1.5-2 mm. `|k2|`/`curvedness` track the SAME shape
// near the peak (since `|k2| >> |k1|` there, a concave crease is nearly
// developable along its crest direction) but lose the sign information that
// keeps the walk (below) from ever being tempted onto a same-magnitude
// CONVEX feature elsewhere on the arch (cusps, incisal edges — genuinely
// present on this same fixture, at comparable curvature magnitude, purely
// convex). `k2` is therefore the field this module walks: a candidate
// vertex counts as "on the ridge" iff `k2 < -opts.minRidgeStrength` (see
// `MARGIN_MIN_RIDGE_STRENGTH` below for the default, and this task's report
// for the measured cluster-separation sweep that default was chosen from).
//
// ## Why concave, not convex (the "shoulder" the analytic fixture models)
//
// A shoulder margin, walked along the tooth's SCANNED (exterior) surface
// from the occlusal axial wall down to the margin, turns from
// "parallel-ish to the insertion axis" to "perpendicular to it" (the flat
// shelf) — a right-angle notch cut INTO the tooth, i.e. concave (material
// fills the reflex side, exactly like the inside corner of a stair step,
// where the tread meets the riser — the outside/top-of-riser corner of the
// SAME step is convex, by contrast). See margin.test-fixtures.ts's module
// doc for the derivation (turning-direction cross product) that pins this
// down precisely, and for why the OTHER standin fixture in this repo
// (undercut/'s `standin-prep-die` collar, Phase 2 Task 9) is NOT usable here
// — it is convex everywhere by construction (a smooth, beveled collar, not a
// true right-angle shoulder), so this task's own `shoulderPrepMesh` fixture
// exists specifically to have a genuine concave crease at a known radius/
// height.
//
// ## Method
//
// 1. **Bounded region** (`boundedVertexRegion`): a Dijkstra ball, in GRAPH
//    distance (sum of 3D edge lengths along mesh edges — see that function's
//    doc for why this is a documented, deliberately CONSERVATIVE proxy for
//    true geodesic distance, never an under-estimate of it), of radius
//    `opts.searchRadiusMm` (default `MARGIN_SEARCH_RADIUS_MM`) around the
//    seed's containing triangle. Every step below (ridge location AND the
//    walk) is confined to this region — the primary defense (per this
//    task's guardrail) against the walk running away onto an unrelated
//    ridge, e.g. a NEIGHBORING tooth's own margin (measured, on the real
//    4-adjacent-prep fixture, to sit as close as ~0.3 mm away in ambient
//    space from this tooth's own margin — see this task's report).
// 2. **Locate the ridge** (`findRidgeStart`): the vertex, among the bounded
//    region, with `k2 < -opts.minRidgeStrength` CLOSEST (by graph distance)
//    to the seed — "nearest ridge locus", per this task's brief, not
//    "strongest" (ties broken by more-negative `k2`, then lowest vertex
//    index, for determinism).
// 3. **Bidirectional crest walk** (`walkRidge`): from the ridge start,
//    establishes two initial directions via `findNextStep` (see below) —
//    direction A is the single STRONGEST candidate reachable within
//    `opts.lookaheadSteps` hops (nothing to score continuation against yet);
//    direction B is a SECOND `findNextStep` search, excluding A's own path,
//    requiring roughly ANTI-PARALLEL continuation from A's established
//    heading (the genuine "other side" of the ridge through the start
//    vertex) — `null` if none exists within the lookahead budget (a
//    one-sided ridge stub; direction A alone must then circumnavigate the
//    WHOLE loop to close). Both directions then step outward independently,
//    one `findNextStep` call at a time, ALTERNATING so closure can be
//    detected as early as possible.
//
//    **`findNextStep`** (this file's own doc on that function has the full
//    measured rationale): a BOUNDED BFS up to `opts.lookaheadSteps` hops
//    from the current vertex (excluding wherever the walk just came from,
//    already-visited-in-this-direction vertices, and anything outside the
//    bounded region), collecting EVERY `k2`-qualifying vertex reached at ANY
//    hop depth (not just the immediate one-ring) whose direction against the
//    walk's SMOOTHED heading (`tangentEma` — "geodesic step regularization
//    to avoid zigzag", this task's brief; see `MARGIN_TANGENT_EMA_WEIGHT`)
//    clears `MARGIN_MIN_DIRECTION_SCORE`, then picks the STRONGEST (most
//    negative `k2`) among them — not the nearest, not the best-scoring
//    direction. This "always search a bounded neighborhood, prefer the
//    strongest ridge point" rule (rather than a strict "1-ring first, then
//    lookahead only as a dead-end fallback" split, an earlier draft's
//    design) is what makes the walk track a real, NOISY margin — MEASURED
//    directly on the real arch-case-01 upperjaw fixture (this task's
//    report): a real `k2`-qualifying region is a WIDE 2D band around the
//    true margin (not a crisp 1-vertex-wide line, unlike this task's clean
//    analytic fixture), and a strict "best-scoring DIRECTION at each
//    1-ring-only step" rule let the walk drift sideways within the band and
//    stall (~2.3mm covered in 30 steps); always widening the search and
//    preferring ridge STRENGTH keeps it centered on the band's true crest
//    (~10mm covered before a genuine dead end, at the measured-safe
//    `MARGIN_LOOKAHEAD_STEPS` default — see that constant's doc for the
//    measured "wider hop budget actively runs away" boundary this default
//    sits just under).
// 4. **Closure**: after every step of EITHER direction, checked against (a)
//    the OTHER direction's current front (the two sides of the loop meeting
//    each other) and (b) the ridge start itself (one side alone
//    circumnavigating the whole loop, if the other died early) — within
//    `opts.closureToleranceMm` (default `MARGIN_CLOSURE_TOLERANCE_MM`) of
//    ambient distance. A direction that runs out of qualifying candidates
//    (dead end) or exceeds `opts.maxStepsPerDirection`
//    (`MARGIN_MAX_WALK_STEPS`) without closing stops; if NEITHER direction
//    ever closes, `NoClosureError` (typed — open margins are invalid, per
//    this task's brief: "the prep finish line is closed by definition").
// 5. **Simplify** (`simplifyRidgeLoop`): an angle-budget march along the
//    walked (full-resolution) vertex loop — accumulates the local turning
//    angle at each vertex, placing an anchor whenever the accumulator
//    exceeds `opts.anchorAngleBudgetRad` (default
//    `MARGIN_ANCHOR_ANGLE_BUDGET_RAD`) OR the running arc length since the
//    last anchor exceeds `MARGIN_ANCHOR_MAX_SPACING_MM` (a straight-run
//    fallback, so a long low-curvature stretch still gets SOME anchors) —
//    dense on tight curves, sparse on straights, deterministic (a pure
//    left-to-right scan of the already-deterministic walk). Anchors are
//    `SurfacePoint`s at the chosen vertices (`surfacePointAtVertex`),
//    directly usable as `fitSurfaceSpline`'s `points` (after
//    `evaluateSurfacePoint`) or as `MarginAnchor`s via `spline/marginLine.ts`.
// 6. **Per-segment confidence** (`segmentConfidence`): for each simplified
//    segment (anchor `i` to anchor `i+1`, wrapping), the mean `|k2|` over the
//    walked sub-path between them, normalized against ONE shared background
//    estimate (the bounded region's mean `|k2|` among NON-qualifying
//    vertices) as `ridgeMean / (ridgeMean + backgroundMean)` — `-> 1` as the
//    segment's ridge strength dominates the local background, `-> 0.5` if it
//    merely matches background (a weak/ambiguous segment the UI should
//    highlight), see that function's doc for the exact formula and why a
//    single shared background (not a fresh per-segment neighborhood) is a
//    deliberate, documented simplification (the whole loop already lives
//    inside one `searchRadiusMm` region, so one background estimate is
//    representative of every segment's surroundings — YAGNI to recompute it
//    per segment).
//
// @errorBound This module's `boundedVertexRegion` graph-distance radius is a
// documented UPPER bound on true geodesic distance (see that function's
// doc) — `searchRadiusMm` is therefore always at least as restrictive as a
// true-geodesic-radius bound would be, never more permissive (the direction
// this safety parameter needs to err in). The walk itself carries no
// separate numerical error bound of its own (it is a discrete, deterministic
// selection over the mesh's own vertices — no interpolation/approximation of
// a continuous quantity beyond `computeCurvature`'s own, already-documented,
// `@errorBound`, curvature/curvature.ts). The prep-die analytic test
// (margin.analytic.test.ts) reports the MEASURED max deviation of every
// walked/simplified anchor from the true analytic shoulder-circle radius —
// see that file for the number and its derivation from tessellation +
// algorithm.
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import type { HalfedgeMesh } from '../halfedge/types.ts';
import type { CurvatureResult } from '../curvature/curvature.ts';
import type { SurfacePoint } from '../geodesic/types.ts';
import { evaluateSurfacePoint, triangleVertexIndices } from '../geodesic/surfacePoint.ts';
import { oneRingVertices } from '../halfedge/iterate.ts';
import { MinHeap } from '../geodesic/heap.ts';

// ---------------------------------------------------------------------------
// Documented algorithmic defaults (kernel-level, NOT clinical-profiles: these
// govern a search/walk heuristic, not a clinical gap/thickness/connector
// parameter — see this task's brief judgment call, mirroring undercutScan's
// own "algorithmic default lives in the kernel" precedent).
// ---------------------------------------------------------------------------

/** Bounded-region search radius (graph distance, mm) around the SEED —
 * used ONLY to LOCATE the nearest ridge locus (module doc, step 2), per this
 * task's brief literal wording ("find the nearest ridge locus WITHIN a
 * bounded geodesic radius"). Default 10mm: a typical prep's own scale (a
 * shoulder margin loop measured ~5-11mm bbox extent on the real fixture —
 * this task's report), comfortably larger than a reasonable seed-placement
 * error, yet — since adjacent real preps were measured as close as ~0.27mm
 * apart — this alone cannot be relied on to keep the search from ever
 * reaching a NEIGHBORING tooth's own ridge (see `MARGIN_WALK_RADIUS_MM`'s
 * doc for the walk's actual, MEASURED defenses — the lookahead hop budget
 * and direction-continuity filter, not an explicit connectivity gate). */
export const MARGIN_SEARCH_RADIUS_MM = 10;

/** A SEPARATE, larger bounded-region radius (graph distance, mm, from the
 * RIDGE START — not the seed) that bounds the WALK itself (module doc, step
 * 3) — deliberately NOT the same value as `MARGIN_SEARCH_RADIUS_MM`. A
 * single tooth's own margin loop can legitimately require the walk to
 * travel up to roughly HALF its own circumference away from the ridge start
 * (the antipodal point on the ring) before the two directions meet — up to
 * ~17.5mm for this task's brief's own "15-35mm incisor" guardrail's upper
 * end, and MEASURED directly to require ~11mm on this task's own 22mm-
 * circumference analytic fixture (`shoulderPrepMesh`) — well past
 * `MARGIN_SEARCH_RADIUS_MM`'s 10mm (confirmed: with `walkRadiusMm` pinned to
 * `MARGIN_SEARCH_RADIUS_MM`, the walk on that SAME fixture dead-ends a few
 * mm short of closing, on BOTH directions simultaneously, right at the
 * region boundary). Default 30mm carries comfortable headroom over the
 * 17.5mm upper anatomical bound.
 *
 * This is safe to be generous with — despite covering a much LARGER area
 * than the ~0.27mm-to-a-few-mm gap between adjacent real preps (this task's
 * report), a neighboring tooth's margin is, in practice, never actually
 * reached through it.
 *
 * CORRECTION (fix batch, T4 review): this doc previously claimed
 * `qualifies()` itself requires ridge CONNECTIVITY at every hop of the walk
 * — it does not, and that overstated the actual mechanism. `qualifies()`
 * (see that function) only gates which CANDIDATE `findNextStep` is allowed
 * to SELECT at a given hop; it does NOT gate the BFS FRONTIER — the
 * `nextQueue` expansion loop inside `findNextStep` recurses through every
 * vertex still inside `region` and not yet visited/seen, REGARDLESS of
 * whether it `qualifies()`. So the walk is not connectivity-gated at every
 * hop. Contrast `findRidgeStart`'s own one-time component-refinement BFS
 * (that function's doc), which genuinely IS gated this way: its expansion
 * step only recurses through vertices that already `qualifies()` — a true
 * connected-component search. The crest walk deliberately does NOT copy
 * that pattern for every step: `findNextStep`'s own doc records that an
 * earlier, MORE restrictive design (1-ring-only, best-scoring-direction —
 * effectively closer to a connectivity-gated walk) measurably drifted
 * sideways and stalled inside a real, noisy ridge BAND (~2.3mm covered in
 * 30 steps) instead of tracking the true crest — the measured
 * drift-and-stall fix this file's doc already documents. A real, noisy
 * `k2`-qualifying region is a band with occasional single-vertex dips below
 * threshold, not a crisp connected line, so gating frontier expansion on
 * `qualifies()` risks reintroducing that exact failure mode; it was
 * therefore deliberately NOT added here.
 *
 * What actually keeps the walk off a neighboring tooth's margin, then, is
 * the COMBINATION of: (1) `MARGIN_LOOKAHEAD_STEPS`'s small, fixed hop budget
 * (a candidate more than that many mesh-edge hops away, qualifying or not,
 * is simply never reached within one step), (2)
 * `MARGIN_MIN_DIRECTION_SCORE`'s heading-continuity filter (a candidate
 * whose direction reverses relative to the walk's established heading is
 * rejected even if it qualifies), and (3) the real-scan cluster survey
 * (this task's report) confirming every pair of adjacent teeth's own
 * `k2 < -MARGIN_MIN_RIDGE_STRENGTH` regions are SEPARATE connected
 * components with a genuine gap of non-qualifying vertices between them.
 * This is a MEASURED outcome on the one real fixture available (verified
 * directly not to be bridged by (1)+(2) together), not a structurally
 * GUARANTEED one the way an explicit connectivity gate would be.
 * `MARGIN_WALK_RADIUS_MM` remains a HANG-GUARD against a genuinely connected
 * runaway ridge (e.g. real-scan noise bridging two features) — see this
 * task's report for the dedicated two-adjacent-seeds test that verifies the
 * observed outcome, and `scripts/diagnose-margin-gap.ts` (fix batch, T4
 * review) for a direct kappa2-profile probe of the one documented
 * non-closing real candidate (this task's report) this reasoning relies on
 * — that probe found the candidate's own dead-end gap sits WITHIN its own
 * cluster's interrupted ridge (a genuine scan-coverage hole, ~5mm along the
 * mesh graph), not at the ambient boundary with a neighboring tooth. */
export const MARGIN_WALK_RADIUS_MM = 30;

/** `k2` (mm^-1) a vertex must be more negative than to count as "on the
 * ridge" — see this file's module doc for the measured real-prep evidence
 * (background -1..-5 mm^-1 near a margin, peak -37.5 mm^-1 AT it; a
 * threshold sweep on the same fixture found -3 mm^-1 cleanly isolates the 4
 * real shoulder-margin clusters from smaller natural-anatomy concave
 * features — this task's report). */
export const MARGIN_MIN_RIDGE_STRENGTH = 3;

/** Minimum connected-component size (vertex count, within the LOCATE-step
 * bounded region) for a `k2`-qualifying component to be eligible as the
 * "nearest ridge locus" `findRidgeStart` searches for — Phase 3 Task 8
 * tuning (measured necessary building the real-fixture acceptance harness,
 * `scripts/margin-acceptance.ts`; see that file and this task's report for
 * the full evidence).
 *
 * MEASURED PROBLEM: a seed placed near (but not precisely ON) a real
 * margin ridge — e.g. Task 8's reference-centroid-derived seeds, as opposed
 * to Task 4's own golden seed, which was hand-picked to sit EXACTLY on a
 * ridge vertex (ambient distance 0.000mm from its own nearest-qualifying
 * vertex) — can have its "nearest qualifying vertex" (unbounded by
 * component) land on an ISOLATED single-vertex (or handful-of-vertices)
 * curvature-noise blip a fraction of a mm away, rather than on the real,
 * hundreds-of-vertices ridge component slightly further off. Without this
 * guard, `findRidgeStart`'s "refine to strongest WITHIN THAT SAME component"
 * step is a no-op on a size-1 component (the noise vertex IS its own
 * component's strongest vertex) — the walk then starts from a spurious,
 * unrepresentative locus. MEASURED on arch-case-01 tooth "21" (the
 * `MARGIN_SEARCH_RADIUS_MM`-bounded region around a reference-centroid seed
 * ~0.78mm from the ridge): nearest-qualifying vertex 74246, its OWN
 * connected component size 1 (an isolated blip), vs. the real ridge
 * component 1211 vertices away — walking from the noise vertex produced a
 * `NoClosureError` (closest approach 1.311mm after 468 steps) where the
 * golden's own on-ridge seed for the SAME tooth closes cleanly (261
 * anchors, 29.7mm).
 *
 * DEFAULT (20): every real shoulder-margin ridge component measured on the
 * real arch-case-01 fixture (Task 4's report; `scripts/diagnose-margin-gap.ts`)
 * is 400-1800+ vertices — comfortably two orders of magnitude above this
 * floor — while the measured noise blip above was size 1. 20 is
 * conservative headroom (an order of magnitude above the observed noise
 * size, two orders below the smallest observed real ridge) without being
 * anywhere near large enough to risk excluding a genuine, smaller ridge
 * feature (e.g. a die/inlay-scale margin on a smaller real or analytic
 * fixture) — every existing analytic fixture (`marginRidge.test-fixtures.ts`'s
 * `shoulderPrepMesh`) has a full-circumference ridge (hundreds of vertices
 * at its tessellation density), so this floor changes NO analytic/property
 * test's outcome — see `marginRidge.property.test.ts`'s own re-run after
 * this change. Purely a "reject isolated noise, not a real small ridge"
 * floor, not a clinical margin-size assumption. */
export const MARGIN_MIN_RIDGE_COMPONENT_SIZE = 20;

/** Loop-closure tolerance (ambient mm) — see this file's module doc, step 4.
 * Comfortably tighter than the smallest inter-tooth margin gap measured on
 * the real 4-adjacent-prep fixture (~0.27 mm — this task's report), and
 * loose enough to absorb the walk's own per-step discretization (real-scan
 * edge lengths near a margin are well under 0.2mm). */
export const MARGIN_CLOSURE_TOLERANCE_MM = 0.15;

/** Minimum walked ARC LENGTH (mm, per direction) before that direction's
 * front becomes ELIGIBLE for a closure check at all — a required companion
 * to `MARGIN_CLOSURE_TOLERANCE_MM`, not an independent knob: on a densely
 * tessellated ring, a direction's front sits well within
 * `closureToleranceMm` of the ridge START (or of the OTHER direction's own
 * nearby front) after just its first couple of steps, PURELY because
 * they're still physically close together near the seed — not because
 * anything has actually circumnavigated the loop. Measured directly on this
 * task's own analytic fixture (`shoulderPrepMesh`, ~22mm circumference, 128
 * circumferential segments, ~0.17mm edge length): without this gate,
 * closure fires after 1-2 steps per direction (`walkVertexCount` 4) at a
 * closure tolerance as loose as 0.6mm — a false positive, not a real loop.
 * Fixed at 2mm (not derived from `closureToleranceMm`, for a predictable,
 * auditable floor): comfortably more than a few real-scan edge hops, yet
 * comfortably under half the smallest anatomically plausible margin loop's
 * own circumference (~15mm / 2 = 7.5mm — this task's brief's own "15-35mm
 * incisor" guardrail), so it never blocks a genuine full-loop return. */
export const MARGIN_CLOSURE_MIN_PROGRESS_MM = 2;

/** Direction-continuation dot-product floor — a candidate whose direction
 * from the current vertex, against the walk's smoothed heading
 * (`tangentEma`), scores below this is rejected as too sharp a
 * turn/reversal (roughly: more than ~70 degrees off the current heading).
 * MEASURED on the real arch-case-01 upperjaw fixture (this task's report):
 * the original, looser `-0.2` (~100 degrees) let the walk wander sideways
 * within a real (wide, noisy) ridge band rather than committing to forward
 * progress — `0.3` (tighter) is what actually let a walk cover a
 * meaningful ~10mm before a genuine dead end, in combination with
 * `findNextStep`'s "strongest ridge, not nearest" selection (see that
 * function's doc) — a genuine sharp corner (this task's own filleted-
 * shoulder analytic test) still turns within this budget at any reasonable
 * real-scan tessellation density. */
export const MARGIN_MIN_DIRECTION_SCORE = 0.3;

/** Bounded k-step lookahead `findNextStep` searches at EVERY step (not
 * merely a same-one-ring-first fallback — see that function's doc for why
 * this changed) — this is a real sensitivity boundary, MEASURED directly on
 * the real arch-case-01 upperjaw fixture (this task's report): `5` covered
 * a genuine ~10mm of real margin before a legitimate dead end; `6` on the
 * SAME fixture, same start point, RAN AWAY (35+mm in one step sequence —
 * almost certainly bridging across real anatomy to an unrelated feature).
 * `5` is therefore not a rounded/arbitrary default — it is the largest
 * value this task's own report measured as still safe on the one real,
 * noisy fixture available; a future task with more real prep fixtures to
 * validate against may be able to widen it (or tighten it) with more
 * evidence.
 *
 * CORRECTION (fix batch, T4 review): this doc previously claimed
 * `findNextStep`'s own `qualifies()` gate "refuses at every hop regardless
 * of how many hops remain" — that overstates what the code does.
 * `qualifies()` gates which candidate the search is allowed to SELECT at a
 * hop (`findNextStep`'s inner scoring loop: `if (!qualifies(...)) continue;`
 * before a candidate is even scored); it does NOT gate the BFS FRONTIER
 * itself — `findNextStep`'s `nextQueue` expansion recurses through ANY
 * vertex still inside `region` and not yet visited/seen, qualifying or not.
 * So a genuine, disconnected NEIGHBORING tooth's margin (measured as close
 * as ~0.27mm away — this task's report) is kept out of reach by the
 * COMBINATION of (a) this small, fixed hop budget (a candidate more than 5
 * mesh-edge hops away is never reached by one `findNextStep` call
 * regardless of qualification) and (b) `MARGIN_MIN_DIRECTION_SCORE`'s
 * heading-continuity filter, together with (c) the real-scan cluster
 * survey's own observation that adjacent teeth's qualifying regions sit
 * several non-qualifying vertices apart on this one fixture — NOT by an
 * explicit connectivity gate on the frontier itself.
 *
 * Contrast `findRidgeStart`'s own component-refinement BFS (that function's
 * doc), which genuinely IS connectivity-gated: its expansion step only
 * recurses through vertices that already `qualifies()`. That one-time,
 * purely local refinement (over a cluster the nearest-qualifying-vertex
 * search already landed in) can afford a strict connectivity gate; the
 * crest WALK deliberately does not copy that pattern for every step,
 * because `findNextStep`'s own doc records that an earlier, MORE
 * restrictive design (1-ring-only, best-scoring-direction — effectively
 * closer to a connectivity-gated walk) measurably drifted sideways and
 * stalled inside a real, noisy ridge BAND (~2.3mm covered in 30 steps)
 * rather than tracking the true crest — the measured drift-and-stall fix.
 * Widening the search past a strict qualifying-only frontier is what let
 * the walk reach ~10mm before a genuine dead end; gating frontier expansion
 * on `qualifies()` risks reintroducing that failure mode, so it was
 * deliberately not added here. See `scripts/diagnose-margin-gap.ts` (fix
 * batch, T4 review) for a direct kappa2-profile probe of the one documented
 * non-closing real candidate (this task's report) this reasoning relies on
 * — that probe found the candidate's own dead-end gap sits WITHIN its own
 * cluster's interrupted ridge (a genuine scan-coverage hole, ~5mm along the
 * mesh graph), not at the ambient boundary with a neighboring tooth. */
export const MARGIN_LOOKAHEAD_STEPS = 5;

/** Hard cap on walk steps PER DIRECTION — hang-guard for a pathological
 * mesh/threshold combination (mirrors `GEODESIC_MAX_ITERATIONS`'s role).
 * Generous relative to the largest real-prep loop measured (~1800 ridge-
 * qualifying vertices in the whole cluster, of which only a fraction lie
 * ON the walked crest line itself). */
export const MARGIN_MAX_WALK_STEPS = 4000;

/** Turning-angle budget (radians) that triggers a new simplified anchor —
 * see this file's module doc, step 5. ~17 degrees: dense enough to track a
 * tight shoulder curve, sparse on straight runs. */
export const MARGIN_ANCHOR_ANGLE_BUDGET_RAD = 0.3;

/** Straight-run fallback max spacing (mm) between simplified anchors, even
 * with zero accumulated turning angle — keeps a long low-curvature stretch
 * from going anchor-free (which `fitSurfaceSpline`'s Catmull-Rom fit would
 * otherwise have to bridge with very few control points). */
export const MARGIN_ANCHOR_MAX_SPACING_MM = 3;

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Thrown when no `k2`-qualifying vertex exists within `searchRadiusMm` of
 * `seed` — a degenerate seed (flat region, or genuinely too far from any
 * margin) with no ridge to propose from. */
export class NoRidgeFoundError extends Error {
  constructor(searchRadiusMm: number, minRidgeStrength: number) {
    super(
      `proposeMarginLoop: no ridge locus found (k2 < -${minRidgeStrength} mm^-1) within ${searchRadiusMm}mm ` +
        'of the seed — the seed may be on a flat region, or too far from any margin. Try a seed closer to the ' +
        'visible finish line, or a larger searchRadiusMm.',
    );
    this.name = 'NoRidgeFoundError';
  }
}

/** Thrown when the bidirectional walk never closes into a loop (either
 * direction dead-ends, or `MARGIN_MAX_WALK_STEPS` fires) — an open margin
 * proposal is invalid by definition (a prep finish line is always closed).
 * `closureDeviationMm` is the CLOSEST the two walk fronts (or one front and
 * the ridge start) ever got, for diagnosability. */
export class NoClosureError extends Error {
  // Explicit field declarations + body assignment, NOT constructor
  // parameter-property shorthand (`public readonly x: T` in the parameter
  // list) — this class is reachable from the Node worker entry's import
  // closure (kernel-workers' `jobs/margin.ts` imports it), which loads via
  // Node's native TS-STRIPPING loader; that loader does not support
  // TypeScript parameter properties ("TypeScript parameter property is not
  // supported in strip-only mode" — a real, measured worker crash this
  // task's own job test caught before this fix). See CLAUDE.md's "Import
  // extension convention" doc for the same worker-reachable-closure
  // constraint applied to import specifiers; this is the analogous
  // constraint for constructor syntax.
  readonly closureDeviationMm: number;
  readonly closureToleranceMm: number;
  readonly stepsTaken: number;
  /** DIAGNOSTIC ONLY (fix batch, T4 review) — the two directions' final
   * ("dead-end") front vertex indices at the moment the walk gave up,
   * undefined when a direction never got established at all (e.g.
   * direction B found no candidate to start from). NOT part of
   * `proposeMarginLoop`'s stable behavior contract and not used by any
   * production code path — exists solely so a post-mortem tool
   * (`scripts/diagnose-margin-gap.ts`) can locate where a non-closing walk
   * actually stalled without re-implementing the walk. Adding these fields
   * changes no numeric computation on any path (this class is only
   * constructed on the already-failing, non-closing path — never on the
   * golden's own successful `proposeMargin` call). */
  readonly frontAVertex?: number;
  readonly frontBVertex?: number;

  constructor(closureDeviationMm: number, closureToleranceMm: number, stepsTaken: number, frontAVertex?: number, frontBVertex?: number) {
    super(
      `proposeMarginLoop: ridge walk did not close into a loop (closest approach ${closureDeviationMm.toFixed(3)}mm, ` +
        `tolerance ${closureToleranceMm}mm, after ${stepsTaken} steps) — the seed's ridge may be an open feature ` +
        '(not a real margin), or searchRadiusMm/minRidgeStrength may need adjustment.',
    );
    this.name = 'NoClosureError';
    this.closureDeviationMm = closureDeviationMm;
    this.closureToleranceMm = closureToleranceMm;
    this.stepsTaken = stepsTaken;
    this.frontAVertex = frontAVertex;
    this.frontBVertex = frontBVertex;
  }
}

// ---------------------------------------------------------------------------
// Bounded region (Dijkstra over the vertex adjacency graph, GRAPH distance)
// ---------------------------------------------------------------------------

function vertexPos(mesh: IndexedMesh, v: number): Vec3 {
  return [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!];
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Dijkstra ball over `hm`'s vertex adjacency graph (edge weight = 3D
 * Euclidean edge length), seeded from `seed`'s containing triangle's 3
 * vertices (initial distance = straight-line ambient distance from `seed`'s
 * own evaluated position to each corner — a small, deliberately simple
 * "fan-out" bias, not a full corridor search: this is a SAFETY BOUND, not a
 * precision measurement). Returns every vertex reached within `radiusMm`,
 * mapped to its graph distance.
 *
 * **Deliberately NOT a true geodesic distance**: following mesh EDGES only
 * (rather than allowing a straight cut across a triangle interior, as a true
 * surface geodesic would) can only ever be as long as or LONGER than the
 * true geodesic between two points — this graph distance is therefore a
 * documented, always-conservative UPPER bound on true geodesic distance.
 * Used here exactly because that direction of error is the SAFE one for a
 * "don't run away" guardrail: a region bounded this way is always a SUBSET
 * of the true geodesic ball of the same radius, never a superset — it can
 * only under-include, never over-include, a would-be-unrelated ridge
 * further away. See this file's module doc for why the alternative (a full
 * `geodesicPath`-style corridor search, repeated for every candidate vertex)
 * is unnecessary machinery for a bound that only needs to be conservative,
 * not tight.
 */
export function boundedVertexRegion(
  mesh: IndexedMesh,
  hm: HalfedgeMesh,
  seed: SurfacePoint,
  radiusMm: number,
): Map<number, number> {
  const seedPos = evaluateSurfacePoint(mesh, seed);
  const dist = new Map<number, number>();
  const heap = new MinHeap();
  for (const v of triangleVertexIndices(mesh, seed.triangleIndex)) {
    const d = dist3(seedPos, vertexPos(mesh, v));
    if (!dist.has(v) || dist.get(v)! > d) {
      dist.set(v, d);
      heap.push(d, v);
    }
  }

  while (heap.size > 0) {
    const top = heap.pop()!;
    const v = top.id;
    const known = dist.get(v);
    if (known === undefined || top.priority > known) continue; // stale heap entry
    if (known > radiusMm) continue; // do not expand past the radius
    const pv = vertexPos(mesh, v);
    for (const nb of oneRingVertices(hm, v)) {
      const cand = known + dist3(pv, vertexPos(mesh, nb));
      if (cand > radiusMm) continue;
      const existing = dist.get(nb);
      if (existing === undefined || cand < existing) {
        dist.set(nb, cand);
        heap.push(cand, nb);
      }
    }
  }
  return dist;
}

// ---------------------------------------------------------------------------
// SurfacePoint at a vertex (one-hot barycentric on any incident triangle)
// ---------------------------------------------------------------------------

/** A `SurfacePoint` naming vertex `v` exactly (`barycentric` one-hot at
 * whichever of `v`'s incident triangles `hm.vertexHalfedge[v]` anchors) —
 * mirrors `geodesic/funnel.ts`'s private `surfacePointAtVertex` (not
 * exported from that module — this is an independent, small re-derivation,
 * same "duplicated rather than shared" convention this repo already
 * documents for other tiny cross-module helpers — e.g.
 * `undercut.test-fixtures.ts`'s `sixSignedVolume`).
 *
 * @throws {RangeError} if `v` has no incident triangle (`vertexHalfedge[v]
 * === -1`) — never arises for a vertex this module's walk actually visits
 * (every visited vertex came from an incident-triangle-bearing one-ring
 * traversal), guarded defensively anyway.
 */
export function surfacePointAtVertex(mesh: IndexedMesh, hm: HalfedgeMesh, v: number): SurfacePoint {
  const he = hm.vertexHalfedge[v]!;
  if (he === -1) {
    throw new RangeError(`surfacePointAtVertex: vertex ${v} has no incident triangle`);
  }
  const face = hm.face[he]!;
  const [ia, ib, ic] = triangleVertexIndices(mesh, face);
  if (ia === v) return { triangleIndex: face, barycentric: [1, 0, 0] };
  if (ib === v) return { triangleIndex: face, barycentric: [0, 1, 0] };
  if (ic === v) return { triangleIndex: face, barycentric: [0, 0, 1] };
  throw new RangeError(`surfacePointAtVertex: vertex ${v} is not a corner of its own anchor triangle ${face}`);
}

// ---------------------------------------------------------------------------
// Ridge location
// ---------------------------------------------------------------------------

/**
 * Refines `start` (the vertex NEAREST the seed among `region`'s
 * `k2`-qualifying vertices — see `findRidgeStart`) to the STRONGEST (most
 * negative `k2`) vertex within `start`'s own CONNECTED qualifying component
 * (a one-ring BFS over qualifying vertices, restricted to `region`) —
 * MEASURED necessary on the real arch-case-01 upperjaw fixture (this task's
 * report): the literal nearest-qualifying vertex can sit right at the
 * FRINGE of a real (noisy) ridge cluster (`k2` barely past
 * `-minRidgeStrength`, e.g. -3.50 at a -3.0 floor) — a "peninsula" with only
 * one weak, poorly-connected qualifying neighbor (itself a dead end), from
 * which `walkRidge`'s crest-following could never even get started (this
 * task's report measured EXACTLY this: `nearestRidgeVertex`'s one-ring had a
 * single qualifying neighbor, which itself had zero — an immediate
 * `NoClosureError` after 8 total steps).
 *
 * **Why the STRONGEST vertex within `start`'s OWN component, not the
 * strongest in the whole region**: a naive "strongest anywhere in
 * `region`" would risk jumping to a DIFFERENT tooth's own (possibly
 * stronger) margin if it happens to also fall within `searchRadiusMm` of the
 * seed (real preps measured as close as ~0.27mm apart — this task's report)
 * — exactly the "runaway" this task's guardrail warns about. Restricting the
 * search to `start`'s own CONNECTED component (a BFS over `k2`-qualifying
 * one-ring adjacency, which the real-scan cluster survey confirmed is a
 * SEPARATE connected component per tooth — this task's report) keeps this
 * refinement from ever crossing to an unrelated ridge: it can only ever
 * strengthen WHICH POINT within the SAME cluster `findRidgeStart` already
 * located, never change WHICH cluster.
 *
 * On the clean analytic fixture (`shoulderPrepMesh`) the nearest-qualifying
 * vertex already IS the true crest (every ring vertex has identical `k2` by
 * construction), so this refinement is a no-op there — it only measurably
 * changes anything on noisy real-scan curvature.
 */
function findRidgeStart(mesh: IndexedMesh, hm: HalfedgeMesh, curvature: CurvatureResult, region: Map<number, number>, minRidgeStrength: number): number | null {
  // MARGIN_MIN_RIDGE_COMPONENT_SIZE guard (Phase 3 Task 8 tuning — see that
  // constant's doc): reject isolated curvature-noise blips as "nearest
  // ridge locus" candidates before picking one, so a seed that lands
  // slightly off the true ridge cannot get stuck on a same-distance noise
  // vertex instead.
  const componentSizes = computeQualifyingComponentSizes(hm, curvature, region, minRidgeStrength);
  const nearest = findNearestQualifyingVertex(curvature, region, minRidgeStrength, componentSizes);
  if (nearest === null) return null;

  // BFS over `nearest`'s own connected qualifying component (bounded to
  // `region`), tracking the strongest (most negative k2) vertex found.
  const componentVisited = new Set<number>([nearest]);
  const stack = [nearest];
  let strongest = nearest;
  let strongestK2 = curvature.k2[nearest]!;
  while (stack.length > 0) {
    const v = stack.pop()!;
    for (const nb of oneRingVertices(hm, v)) {
      if (componentVisited.has(nb) || !qualifies(curvature, region, nb, minRidgeStrength)) continue;
      componentVisited.add(nb);
      stack.push(nb);
      const k2 = curvature.k2[nb]!;
      if (k2 < strongestK2 - 1e-12 || (Math.abs(k2 - strongestK2) <= 1e-12 && nb < strongest)) {
        strongest = nb;
        strongestK2 = k2;
      }
    }
  }
  return strongest;
}

/**
 * Connected-component size, per `k2`-qualifying vertex, restricted to
 * `region` — one BFS pass over every qualifying vertex reachable in
 * `region` (same one-ring adjacency + `qualifies` predicate `findRidgeStart`
 * itself uses for its refinement step), used by `findNearestQualifyingVertex`
 * to ignore isolated curvature-noise blips. See `MARGIN_MIN_RIDGE_COMPONENT_SIZE`'s
 * doc for the measured motivating case.
 */
function computeQualifyingComponentSizes(
  hm: HalfedgeMesh,
  curvature: CurvatureResult,
  region: Map<number, number>,
  minRidgeStrength: number,
): Map<number, number> {
  const sizes = new Map<number, number>();
  const visited = new Set<number>();
  for (const v of region.keys()) {
    if (visited.has(v) || !qualifies(curvature, region, v, minRidgeStrength)) continue;
    const component: number[] = [];
    const stack = [v];
    visited.add(v);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      component.push(cur);
      for (const nb of oneRingVertices(hm, cur)) {
        if (visited.has(nb) || !qualifies(curvature, region, nb, minRidgeStrength)) continue;
        visited.add(nb);
        stack.push(nb);
      }
    }
    for (const cv of component) sizes.set(cv, component.length);
  }
  return sizes;
}

function findNearestQualifyingVertex(
  curvature: CurvatureResult,
  region: Map<number, number>,
  minRidgeStrength: number,
  componentSizes: Map<number, number>,
): number | null {
  let best: number | null = null;
  let bestGraphDist = Infinity;
  let bestK2 = 0;
  for (const [v, graphDist] of region) {
    if (curvature.isBoundary[v]) continue;
    const k2 = curvature.k2[v]!;
    if (!(k2 < -minRidgeStrength)) continue;
    if ((componentSizes.get(v) ?? 0) < MARGIN_MIN_RIDGE_COMPONENT_SIZE) continue;
    if (
      graphDist < bestGraphDist - 1e-12 ||
      (Math.abs(graphDist - bestGraphDist) <= 1e-12 && (k2 < bestK2 - 1e-12 || (k2 === bestK2 && (best === null || v < best))))
    ) {
      best = v;
      bestGraphDist = graphDist;
      bestK2 = k2;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Crest-following walk
// ---------------------------------------------------------------------------

function qualifies(curvature: CurvatureResult, region: Map<number, number>, v: number, minRidgeStrength: number): boolean {
  return region.has(v) && !curvature.isBoundary[v] && curvature.k2[v]! < -minRidgeStrength;
}

/** Weight given to walk HISTORY (vs. the newest single step) when updating
 * `DirectedWalkState.tangentEma` — "geodesic step regularization to avoid
 * zigzag" (this task's brief). MEASURED necessary on the real arch-case-01
 * upperjaw fixture (this task's report): a real, noisy `k2`-qualifying
 * region is a 2D BAND around the true margin (not a crisp 1-vertex-wide
 * line), so the single best-scoring neighbor at any one step can wobble
 * sideways within the band — a walk that re-derives its tangent from ONLY
 * the immediately-previous edge (`stepDirection`'s original, pre-this-fix
 * behavior) chases that per-step wobble and covers only ~2.3mm of actual
 * arc length in 30 steps (should be ~4-5mm at this mesh's edge-length
 * scale — most of the "progress" lost to backtracking/zigzag). Smoothing
 * the tangent over recent history damps the wobble while still tracking
 * genuine curvature (a real margin loop's own curvature radius is large
 * relative to one mesh edge, so the smoothed tangent lags a true direction
 * change only slightly). 0.6 (60% history / 40% newest step) — chosen
 * empirically on the real fixture as enough smoothing to escape the
 * zigzag stall while still responsive enough to follow the loop's own
 * curvature (not so much smoothing the walk goes straight through a real
 * corner). */
export const MARGIN_TANGENT_EMA_WEIGHT = 0.6;

/** Blends `prevEma` (the walk's smoothed heading so far) with the NEWEST
 * single step direction `newDir` — see `MARGIN_TANGENT_EMA_WEIGHT`'s doc.
 * `prevEma === null` (the very first step, nothing to smooth against yet)
 * returns `newDir` unchanged. */
function updateTangentEma(prevEma: Vec3 | null, newDir: Vec3): Vec3 {
  if (prevEma === null) return newDir;
  const w = MARGIN_TANGENT_EMA_WEIGHT;
  return normalize3([prevEma[0] * w + newDir[0] * (1 - w), prevEma[1] * w + newDir[1] * (1 - w), prevEma[2] * w + newDir[2] * (1 - w)]);
}

interface DirectedWalkState {
  /** Vertex path, in walk order, STARTING at the ridge start (index 0) and
   * NOT including the ridge start twice across both directions when spliced
   * (see `walkRidge`). */
  path: number[];
  visited: Set<number>;
  deadEnd: boolean;
  /** Cumulative 3D edge length walked so far (sum of consecutive `path`
   * distances) — gates closure eligibility, see
   * `MARGIN_CLOSURE_MIN_PROGRESS_MM`'s doc. */
  arcLengthMm: number;
  /** Exponentially-smoothed step direction — "geodesic step regularization"
   * (this task's brief) against zigzag: see `updateTangentEma`'s doc. `null`
   * before the first step has a direction to smooth. */
  tangentEma: Vec3 | null;
}

/** One step of the crest-following walk from `state`'s current front — see
 * this file's module doc, step 3. Mutates `state` in place; returns `true`
 * if a step was taken, `false` if this direction just dead-ended (no more
 * steps will ever be possible). */
function stepDirection(
  mesh: IndexedMesh,
  hm: HalfedgeMesh,
  curvature: CurvatureResult,
  region: Map<number, number>,
  minRidgeStrength: number,
  lookaheadSteps: number,
  state: DirectedWalkState,
): boolean {
  if (state.deadEnd) return false;
  const current = state.path[state.path.length - 1]!;
  const prev = state.path.length >= 2 ? state.path[state.path.length - 2]! : null;
  const currentPos = vertexPos(mesh, current);
  // Smoothed heading (`state.tangentEma`), not the raw single-edge
  // `prev -> current` direction — see `MARGIN_TANGENT_EMA_WEIGHT`'s doc.
  const tangent: Vec3 | null = state.tangentEma;

  const nextPath = findNextStep(mesh, hm, curvature, region, minRidgeStrength, lookaheadSteps, current, prev, tangent, state.visited);
  if (nextPath !== null) {
    let from = currentPos;
    for (const v of nextPath) {
      const vp = vertexPos(mesh, v);
      state.tangentEma = updateTangentEma(state.tangentEma, normalize3(sub3(vp, from)));
      state.arcLengthMm += dist3(from, vp);
      from = vp;
      state.path.push(v);
      state.visited.add(v);
    }
    return true;
  }

  state.deadEnd = true;
  return false;
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function normalize3(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 0];
}
function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Finds the next step: a BOUNDED BFS up to `lookaheadSteps` hops from
 * `current` (excluding `prev`, already-`visited` vertices, and anything
 * outside `region`), collecting EVERY `k2`-qualifying vertex reached at any
 * hop depth — not just the immediate one-ring — and returning the ordered
 * intermediate-plus-target path to the BEST one (so any skipped
 * intermediate vertices become part of the walked path too, even though
 * they were reached in a single multi-hop step). `null` if nothing
 * qualifying, at any depth, clears `MARGIN_MIN_DIRECTION_SCORE`.
 *
 * **Selection: STRONGEST ridge (most negative `k2`) among direction-
 * qualifying candidates — not best-scoring direction, and ALWAYS searched
 * this way (not merely as a same-one-ring-first / lookahead-as-fallback
 * split, this function's earlier design)**. MEASURED necessary on the real
 * arch-case-01 upperjaw fixture (this task's report): a real, noisy `k2`-
 * qualifying region is a WIDE 2D band around the true margin (not a crisp
 * 1-vertex-wide line, unlike this task's clean analytic fixture, where
 * every ring vertex shares the SAME `k2` and this reduces to the direction-
 * score-only rule this function's earlier draft used) — picking only the
 * best-scoring DIRECTION at each 1-ring-only step let the walk drift
 * sideways within the band and stall (measured: ~2.3mm covered in 30 steps,
 * repeatedly dead-ending on a band-interior vertex whose only remaining
 * unvisited neighbors scored as "backward" relative to an already-drifted
 * tangent). Always searching a WIDER neighborhood and preferring the
 * STRONGEST ridge point (once direction-qualified) keeps the walk centered
 * on the band's true crest, which measurably tracks much farther per step
 * (this task's report: ~10mm covered before a genuine dead end, at
 * `MARGIN_LOOKAHEAD_STEPS = 5`). A wider hop budget than that was measured
 * to actively RUN AWAY (35+mm in one step sequence — almost certainly
 * bridging to unrelated anatomy) — `MARGIN_LOOKAHEAD_STEPS`'s doc records
 * this boundary.
 *
 * Deterministic tie-break among direction-qualifying candidates: most
 * negative `k2` first, then SHORTEST hop-path (prefer a closer, equally
 * strong point over a farther one — this is what keeps the clean analytic
 * fixture's single-ring walk from skipping ahead: every ring vertex shares
 * the same `k2`, so the 1-hop neighbor always wins the hop-count tie-break),
 * then best direction score, then lowest target vertex index.
 */
function findNextStep(
  mesh: IndexedMesh,
  hm: HalfedgeMesh,
  curvature: CurvatureResult,
  region: Map<number, number>,
  minRidgeStrength: number,
  lookaheadSteps: number,
  current: number,
  prev: number | null,
  tangent: Vec3 | null,
  visited: ReadonlySet<number>,
): number[] | null {
  interface QueueItem {
    v: number;
    path: number[]; // path from `current` to `v`, exclusive of `current`
  }
  const currentPos = vertexPos(mesh, current);
  const startCandidates = oneRingVertices(hm, current).filter((nb) => nb !== prev && !visited.has(nb) && region.has(nb));
  let queue: QueueItem[] = startCandidates.map((v) => ({ v, path: [v] }));
  const seenInBfs = new Set<number>(startCandidates);
  seenInBfs.add(current);

  let best: QueueItem | null = null;
  let bestK2 = 0;
  let bestScore = -Infinity;

  for (let hop = 0; hop < lookaheadSteps && queue.length > 0; hop++) {
    for (const item of queue) {
      if (!qualifies(curvature, region, item.v, minRidgeStrength)) continue;
      const dir = normalize3(sub3(vertexPos(mesh, item.v), currentPos));
      const score = tangent === null ? 1 : dot3(tangent, dir);
      if (tangent !== null && score < MARGIN_MIN_DIRECTION_SCORE) continue;
      const k2 = curvature.k2[item.v]!;
      if (
        best === null ||
        k2 < bestK2 - 1e-12 ||
        (Math.abs(k2 - bestK2) <= 1e-12 &&
          (item.path.length < best.path.length ||
            (item.path.length === best.path.length &&
              (score > bestScore + 1e-12 || (Math.abs(score - bestScore) <= 1e-12 && item.v < best.v)))))
      ) {
        best = item;
        bestK2 = k2;
        bestScore = score;
      }
    }
    // Deterministic within-hop scan order (queue itself is built in a fixed
    // order below), so ties are already resolved consistently above — no
    // separate "stop at first hop with any qualifying candidate" early
    // return: a DEEPER hop can legitimately win (stronger ridge point),
    // matching this function's own "strongest, not nearest" doc.
    const nextQueue: QueueItem[] = [];
    for (const item of queue) {
      for (const nb of oneRingVertices(hm, item.v)) {
        if (seenInBfs.has(nb) || visited.has(nb) || !region.has(nb)) continue;
        seenInBfs.add(nb);
        nextQueue.push({ v: nb, path: [...item.path, nb] });
      }
    }
    queue = nextQueue;
  }
  return best === null ? null : best.path;
}

export interface RidgeWalkResult {
  /** The full, ordered, CLOSED vertex loop (last vertex is adjacent to
   * `loop[0]` on the mesh's ridge — NOT repeated at the end). */
  loop: number[];
  closureDeviationMm: number;
}

/**
 * Bidirectional crest-following walk from `ridgeStart` — see this file's
 * module doc, steps 3-4.
 *
 * @throws {NoClosureError} if neither direction ever closes the loop within
 * `closureToleranceMm`, or `NoRidgeFoundError` if `ridgeStart` has no
 * qualifying candidate reachable within `opts.lookaheadSteps` hops to start
 * a walk from at all (an isolated ridge point, not a real extended feature).
 */
export function walkRidge(
  mesh: IndexedMesh,
  hm: HalfedgeMesh,
  curvature: CurvatureResult,
  region: Map<number, number>,
  ridgeStart: number,
  opts: { minRidgeStrength: number; closureToleranceMm: number; lookaheadSteps: number; maxStepsPerDirection: number; walkRadiusMm: number },
): RidgeWalkResult {
  const startPos = vertexPos(mesh, ridgeStart);

  // Direction A: the single STRONGEST candidate reachable within
  // `lookaheadSteps` hops of `ridgeStart` (tangent === null accepts any
  // direction — nothing established yet — see `findNextStep`'s doc).
  const dirAPath = findNextStep(mesh, hm, curvature, region, opts.minRidgeStrength, opts.lookaheadSteps, ridgeStart, null, null, new Set([ridgeStart]));
  if (dirAPath === null) {
    throw new NoRidgeFoundError(opts.walkRadiusMm, opts.minRidgeStrength);
  }
  const stateA = buildInitialWalkState(mesh, ridgeStart, startPos, dirAPath);

  // Direction B: a SECOND search from `ridgeStart` (not restricted to its
  // immediate one-ring — see this function's doc below), excluding
  // everything direction A already claimed, requiring roughly ANTI-PARALLEL
  // continuation from A's own established heading — the genuine "other
  // side" of the ridge through `ridgeStart`. `null` if no such candidate
  // exists within the lookahead budget (a one-sided ridge stub — direction A
  // alone must then circumnavigate the WHOLE loop to close, see
  // `checkClosure`'s `'aAlone'` case below).
  const negatedTangentA: Vec3 | null = stateA.tangentEma && ([-stateA.tangentEma[0], -stateA.tangentEma[1], -stateA.tangentEma[2]] as Vec3);
  const dirBPath = findNextStep(mesh, hm, curvature, region, opts.minRidgeStrength, opts.lookaheadSteps, ridgeStart, null, negatedTangentA, stateA.visited);
  const stateB: DirectedWalkState | null = dirBPath === null ? null : buildInitialWalkState(mesh, ridgeStart, startPos, dirBPath);
  if (stateB) {
    for (const v of stateB.path) stateA.visited.add(v);
    for (const v of stateA.path) stateB.visited.add(v);
  }

  let closestApproach = Infinity;
  // See `MARGIN_CLOSURE_MIN_PROGRESS_MM`'s doc for why "back near start"/
  // "fronts meeting" checks only become eligible after minimum progress.
  // IMPORTANT: a 'aAlone'/'bAlone' closure means THAT direction alone
  // circumnavigated the WHOLE loop — the loop is exactly that direction's
  // own path, and the OTHER direction's (necessarily shorter, since it
  // hasn't also closed) partial progress must be DISCARDED, not spliced in
  // (splicing both would double-count the shared arc — see `spliceLoop`'s
  // doc).
  //
  // ## GRAPH-based "meet" (checked FIRST, before the distance-based
  // fallback) — MEASURED necessary on the real arch-case-01 upperjaw
  // fixture (this task's report)
  //
  // `findNextStep` does NOT exclude the OTHER direction's vertices from
  // candidacy (only the CALLING direction's own `visited` set — see that
  // function's signature; `stateA.visited`/`stateB.visited` are only
  // synchronized ONCE, at setup, over each other's INITIAL path, never kept
  // in sync as they walk further) — so direction A can, and on real noisy
  // data DOES, legitimately step onto a vertex direction B already visited
  // (the two tracks through a wide, noisy ridge band converging exactly, a
  // true topological meeting), WITHOUT the two fronts' final vertices
  // necessarily being within any small ambient DISTANCE of each other (this
  // task's report measured a real closure this way at a resolved ~1.6mm
  // final ambient front-to-front gap — comfortably outside
  // `MARGIN_CLOSURE_TOLERANCE_MM`'s analytic-fixture-tuned default, yet the
  // walk had genuinely, unambiguously closed the loop on the mesh GRAPH).
  // This check is exact (a vertex either was or wasn't visited — no
  // threshold to tune) and is therefore ALWAYS preferred over the distance-
  // based fallback below when it fires.
  const checkClosure = (): ClosureHit | null => {
    const frontAVertex = stateA.path[stateA.path.length - 1]!;
    const frontA = vertexPos(mesh, frontAVertex);
    if (stateA.arcLengthMm >= MARGIN_CLOSURE_MIN_PROGRESS_MM) {
      const d = dist3(frontA, startPos);
      closestApproach = Math.min(closestApproach, d);
      if (d <= opts.closureToleranceMm) return { kind: 'aAlone', deviation: d };
    }
    if (stateB) {
      const frontBVertex = stateB.path[stateB.path.length - 1]!;
      const frontB = vertexPos(mesh, frontBVertex);
      if (stateB.arcLengthMm >= MARGIN_CLOSURE_MIN_PROGRESS_MM) {
        const d = dist3(frontB, startPos);
        closestApproach = Math.min(closestApproach, d);
        if (d <= opts.closureToleranceMm) return { kind: 'bAlone', deviation: d };
      }
      if (stateA.arcLengthMm >= MARGIN_CLOSURE_MIN_PROGRESS_MM && stateB.arcLengthMm >= MARGIN_CLOSURE_MIN_PROGRESS_MM) {
        const meetIndexInB = stateB.path.indexOf(frontAVertex);
        if (meetIndexInB !== -1) {
          closestApproach = 0;
          return { kind: 'meet', deviation: 0, truncateBAt: meetIndexInB };
        }
        const meetIndexInA = stateA.path.indexOf(frontBVertex);
        if (meetIndexInA !== -1) {
          closestApproach = 0;
          return { kind: 'meet', deviation: 0, truncateAAt: meetIndexInA };
        }
        const dAB = dist3(frontA, frontB);
        closestApproach = Math.min(closestApproach, dAB);
        if (dAB <= opts.closureToleranceMm) return { kind: 'meet', deviation: dAB };
      }
    }
    return null;
  };

  for (let step = 0; step < opts.maxStepsPerDirection; step++) {
    if (!stateA.deadEnd) {
      stepDirection(mesh, hm, curvature, region, opts.minRidgeStrength, opts.lookaheadSteps, stateA);
      const closed = checkClosure();
      if (closed !== null) return spliceLoop(stateA, stateB, closed);
    }
    if (stateB && !stateB.deadEnd) {
      stepDirection(mesh, hm, curvature, region, opts.minRidgeStrength, opts.lookaheadSteps, stateB);
      const closed = checkClosure();
      if (closed !== null) return spliceLoop(stateA, stateB, closed);
    }
    if (stateA.deadEnd && (!stateB || stateB.deadEnd)) break;
  }

  throw new NoClosureError(
    closestApproach,
    opts.closureToleranceMm,
    stateA.path.length + (stateB?.path.length ?? 0),
    stateA.path[stateA.path.length - 1],
    stateB?.path[stateB.path.length - 1],
  );
}

/** Builds a `DirectedWalkState` from an initial multi-vertex path found by
 * `findNextStep` (direction A/B's own starting search, `walkRidge`) —
 * replays the SAME `tangentEma`/`arcLengthMm` accumulation `stepDirection`'s
 * loop applies per-step, just for the initial jump (which, like any
 * `findNextStep` result, may itself span more than one hop). */
function buildInitialWalkState(mesh: IndexedMesh, ridgeStart: number, startPos: Vec3, path: readonly number[]): DirectedWalkState {
  const visited = new Set<number>([ridgeStart, ...path]);
  let arcLengthMm = 0;
  let tangentEma: Vec3 | null = null;
  let from = startPos;
  for (const v of path) {
    const vp = vertexPos(mesh, v);
    tangentEma = updateTangentEma(tangentEma, normalize3(sub3(vp, from)));
    arcLengthMm += dist3(from, vp);
    from = vp;
  }
  return { path: [ridgeStart, ...path], visited, deadEnd: false, arcLengthMm, tangentEma };
}

interface ClosureHit {
  kind: 'aAlone' | 'bAlone' | 'meet';
  deviation: number;
  /** GRAPH-based `'meet'` only (see `checkClosure`'s doc): the index within
   * `stateB.path`/`stateA.path` where the OTHER direction's front vertex was
   * found — `spliceLoop` truncates that path to this index (dropping its
   * own now-redundant tail beyond the meeting point) instead of splicing in
   * its whole, possibly-overshooting path. At most one of these is ever set
   * (the two `indexOf` checks in `checkClosure` are mutually exclusive per
   * call — a vertex cannot be simultaneously A's current front AND found
   * inside B's path AND vice versa in the same check without one of the two
   * `indexOf` calls firing first). */
  truncateAAt?: number;
  truncateBAt?: number;
}

/**
 * Assembles the final closed vertex loop from the two walk directions and
 * WHICH closure condition fired (`hit.kind`) — see `walkRidge`'s
 * `checkClosure` doc.
 *
 * - `'aAlone'`/`'bAlone'`: that ONE direction alone circumnavigated the
 *   whole loop back near `ridgeStart` — the loop is EXACTLY that
 *   direction's own path (`stateA.path`/`stateB.path`, dropping the final
 *   entry, which sits AT/NEAR `ridgeStart` again — a closed loop's `loop[0]`
 *   already IS `ridgeStart`, per this function's return contract, so
 *   repeating it would duplicate a vertex). The OTHER direction's own
 *   (necessarily incomplete, since it hasn't ALSO closed) progress is
 *   DISCARDED — splicing it in as well would double-count the arc both
 *   directions share near `ridgeStart` (this was a real bug caught by this
 *   task's own analytic fixture test: without this discrimination, a
 *   1-direction-alone closure on a 128-vertex ring produced a 129-vertex
 *   "loop" that silently included the other, still-partial direction's
 *   path too).
 * - `'meet'`: the two directions' fronts converged — the loop is
 *   `stateA.path + reverse(stateB.path without its own ridgeStart)`, i.e.
 *   walking `ridgeStart -> ...A... -> (near the meeting point) ->
 *   ...B(reversed)... -> ridgeStart`. A possible exact-duplicate seam (A's
 *   front === B's front, e.g. a zero-length final gap) is dropped.
 */
function spliceLoop(stateA: DirectedWalkState, stateB: DirectedWalkState | null, hit: ClosureHit): RidgeWalkResult {
  // 'aAlone'/'bAlone': the closing direction's FRONT is a distinct vertex
  // from `ridgeStart` (the visited-set guard means it can never literally
  // REVISIT `ridgeStart` itself) that merely sits within
  // `closureToleranceMm` of it — the whole path, front included, is real
  // ridge geometry; the implicit final wraparound edge (front -> ridgeStart)
  // is exactly this `RidgeWalkResult.loop`'s own documented convention
  // ("last vertex is adjacent to loop[0] ... NOT repeated at the end"), so
  // nothing is dropped.
  if (hit.kind === 'aAlone') {
    return { loop: stateA.path.slice(), closureDeviationMm: hit.deviation };
  }
  if (hit.kind === 'bAlone') {
    // stateB is guaranteed non-null here — `checkClosure` only ever returns
    // `'bAlone'` from inside its `if (stateB)` branch.
    return { loop: stateB!.path.slice(), closureDeviationMm: hit.deviation };
  }
  // 'meet', GRAPH-based (`hit.truncateAAt`/`hit.truncateBAt` set — see
  // `checkClosure`'s doc): one direction's front was found INSIDE the
  // other's path, possibly NOT at that path's own end (a real, noisy-data
  // "the two tracks converged partway, not exactly at each one's final
  // step" case) — truncate the CONTAINING path to the meeting index
  // (dropping its own now-redundant tail beyond it) instead of splicing in
  // the whole thing.
  if (hit.truncateBAt !== undefined) {
    // `stateB.path[hit.truncateBAt] === stateA.path`'s own last element (the
    // vertex `checkClosure` matched) — already present as `stateA.path`'s
    // final entry, so EXCLUDED here (up to, not including, `truncateBAt`) to
    // avoid a duplicate at the seam (see this function's earlier doc on the
    // 129-vertex-loop bug this exact mistake caused before).
    const bHead = stateB!.path.slice(1, hit.truncateBAt); // exclude B's own ridgeStart (index 0) AND the matched duplicate
    const loop = [...stateA.path, ...bHead.reverse()];
    if (loop.length > 1 && loop[0] === loop[loop.length - 1]) loop.pop();
    return { loop, closureDeviationMm: hit.deviation };
  }
  if (hit.truncateAAt !== undefined) {
    // Symmetric: `stateA.path[hit.truncateAAt] === stateB.path`'s own last
    // (matched) element — `bTail` excludes it (`slice(1, -1)`, dropping both
    // B's own ridgeStart AND its duplicate front) since `aHead` already ends
    // with that same vertex.
    const aHead = stateA.path.slice(0, hit.truncateAAt + 1);
    const bTail = stateB!.path.slice(1, -1);
    const loop = [...aHead, ...bTail.reverse()];
    if (loop.length > 1 && loop[0] === loop[loop.length - 1]) loop.pop();
    return { loop, closureDeviationMm: hit.deviation };
  }
  // 'meet', DISTANCE-based fallback: A's and B's fronts may have landed on
  // the EXACT SAME vertex (each walking to it from an opposite direction —
  // possible on an even-length ring) — in that case `stateB`'s own copy of
  // that shared vertex is a duplicate and is dropped (rather than only ever
  // checking for a duplicate at `loop[0]`/`loop[last]`, which misses THIS
  // seam, roughly in the MIDDLE of the array — caught by this task's own
  // analytic fixture test: an unguarded splice produced a 129-vertex loop
  // for a genuine 128-vertex ring, a real correctness bug, not just an
  // off-by-one cosmetic one).
  const aFront = stateA.path[stateA.path.length - 1]!;
  const bFront = stateB!.path[stateB!.path.length - 1]!;
  const bTail = aFront === bFront ? stateB!.path.slice(1, -1) : stateB!.path.slice(1);
  const loop = [...stateA.path, ...bTail.reverse()];
  if (loop.length > 1 && loop[0] === loop[loop.length - 1]) loop.pop();
  return { loop, closureDeviationMm: hit.deviation };
}

// ---------------------------------------------------------------------------
// Simplification (angle-budget marching)
// ---------------------------------------------------------------------------

/** Curvature-adaptive simplification of a closed vertex loop into anchor
 * vertex INDICES (not yet `SurfacePoint`s — see `proposeMarginLoop` for that
 * conversion) — see this file's module doc, step 5. Always keeps `loop[0]`.
 * Deterministic, single forward scan. */
export function simplifyRidgeLoopIndices(
  mesh: IndexedMesh,
  loop: readonly number[],
  angleBudgetRad: number,
  maxSpacingMm: number,
): number[] {
  if (loop.length <= 3) return loop.slice();
  const anchors: number[] = [loop[0]!];
  let accumAngle = 0;
  let accumLen = 0;
  for (let i = 1; i < loop.length; i++) {
    const prev = loop[i - 1]!;
    const cur = loop[i]!;
    const next = loop[(i + 1) % loop.length]!;
    accumLen += dist3(vertexPos(mesh, prev), vertexPos(mesh, cur));
    const inTangent = normalize3(sub3(vertexPos(mesh, cur), vertexPos(mesh, prev)));
    const outTangent = normalize3(sub3(vertexPos(mesh, next), vertexPos(mesh, cur)));
    const cosAngle = Math.max(-1, Math.min(1, dot3(inTangent, outTangent)));
    const turnAngle = Math.acos(cosAngle);
    accumAngle += turnAngle;
    if (accumAngle >= angleBudgetRad || accumLen >= maxSpacingMm) {
      anchors.push(cur);
      accumAngle = 0;
      accumLen = 0;
    }
  }
  // Guarantee at least 3 anchors (a spline/loop needs >= 3 control points) —
  // an extremely tight angle/spacing budget on a small loop could otherwise
  // under-produce; fall back to evenly-strided vertices from the walk.
  if (anchors.length < 3) {
    const stride = Math.max(1, Math.floor(loop.length / 3));
    return [loop[0]!, loop[stride % loop.length]!, loop[(2 * stride) % loop.length]!];
  }
  return anchors;
}

// ---------------------------------------------------------------------------
// Per-segment confidence
// ---------------------------------------------------------------------------

/** Mean `|k2|` over `region`'s NON-qualifying vertices — the "local
 * background" baseline `segmentConfidence` normalizes against (see module
 * doc, step 6). Falls back to a small positive epsilon if every region
 * vertex happens to qualify (degenerate — avoids a divide-by-zero; the
 * confidence formula then saturates toward 1 for every segment, which is
 * the correct qualitative answer: an all-ridge neighborhood has no
 * meaningful "background" to be weak relative to). */
function backgroundRidgeStrength(curvature: CurvatureResult, region: Map<number, number>, minRidgeStrength: number): number {
  let sum = 0;
  let count = 0;
  for (const v of region.keys()) {
    if (curvature.isBoundary[v]) continue;
    const k2 = curvature.k2[v]!;
    if (k2 < -minRidgeStrength) continue; // ridge-qualifying — excluded from "background"
    sum += Math.abs(k2);
    count++;
  }
  return count > 0 ? sum / count : 1e-6;
}

/** Per-segment confidence: mean `|k2|` over the walked sub-path between
 * consecutive anchors, normalized as `ridgeMean / (ridgeMean +
 * backgroundMean)` — see module doc, step 6. `anchorLoopIndices[i]` and
 * `[i+1]` (wrapping) are positions WITHIN `loop` (not vertex ids). */
export function segmentConfidence(
  curvature: CurvatureResult,
  loop: readonly number[],
  anchorLoopIndices: readonly number[],
  backgroundMean: number,
): number[] {
  const out: number[] = new Array(anchorLoopIndices.length);
  for (let i = 0; i < anchorLoopIndices.length; i++) {
    const from = anchorLoopIndices[i]!;
    const to = anchorLoopIndices[(i + 1) % anchorLoopIndices.length]!;
    let sum = 0;
    let count = 0;
    let idx = from;
    for (;;) {
      sum += Math.abs(curvature.k2[loop[idx]!]!);
      count++;
      if (idx === to) break;
      idx = (idx + 1) % loop.length;
    }
    const ridgeMean = count > 0 ? sum / count : 0;
    out[i] = ridgeMean / (ridgeMean + backgroundMean);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export interface ProposeMarginLoopOptions {
  /** Bounded graph-distance search radius, mm — default `MARGIN_SEARCH_RADIUS_MM`. */
  searchRadiusMm?: number;
  /** Ridge-qualification floor on `-k2`, mm^-1 — default `MARGIN_MIN_RIDGE_STRENGTH`. */
  minRidgeStrength?: number;
  /** Bounded graph-distance radius (mm) FROM THE RIDGE START (not the seed)
   * the walk itself is confined to — default `MARGIN_WALK_RADIUS_MM`. See
   * that constant's doc for why this is deliberately larger than
   * `searchRadiusMm`. */
  walkRadiusMm?: number;
  /** Loop-closure tolerance, mm — default `MARGIN_CLOSURE_TOLERANCE_MM`. */
  closureToleranceMm?: number;
  /** Bounded lookahead hop budget — default `MARGIN_LOOKAHEAD_STEPS`. */
  lookaheadSteps?: number;
  /** Hard walk-step cap per direction — default `MARGIN_MAX_WALK_STEPS`. */
  maxStepsPerDirection?: number;
  /** Anchor-simplification turning-angle budget, radians — default
   * `MARGIN_ANCHOR_ANGLE_BUDGET_RAD`. */
  anchorAngleBudgetRad?: number;
  /** Anchor-simplification straight-run max spacing, mm — default
   * `MARGIN_ANCHOR_MAX_SPACING_MM`. */
  anchorMaxSpacingMm?: number;
}

export interface ProposeMarginLoopResult {
  /** Simplified, ordered, CLOSED-loop anchors (NOT repeating the first point
   * at the end — same convention as `SurfaceSpline.controlPoints` /
   * `fitSurfaceSpline`'s `closed: true`), ready for `fitSurfaceSpline` (via
   * `evaluateSurfacePoint` for the ambient positions) or `spline/
   * marginLine.ts`'s `toMarginLine`. */
  anchors: SurfacePoint[];
  /** Always `true` on a successful return — a `NoClosureError` is thrown
   * instead of ever returning an open result (see this file's module doc).
   * Kept as an explicit field (rather than omitted) to match the shape this
   * task's brief specifies (`{ anchors, closed, confidence per-segment }`). */
  closed: true;
  /** Per-segment confidence, `anchors.length` entries, `segmentConfidence[i]`
   * covers `anchors[i] -> anchors[(i+1) % anchors.length]` — see this file's
   * module doc, step 6. */
  segmentConfidence: number[];
  /** Diagnostics: the full-resolution walked loop's vertex count (before
   * simplification) and how close the walk's two directions actually got at
   * closure (mm) — surfaced for tests/QC, not required by production callers. */
  walkVertexCount: number;
  closureDeviationMm: number;
  /** Echo of the resolved (default-filled) `searchRadiusMm` actually used. */
  searchRadiusMm: number;
}

/**
 * Proposes a closed margin loop from `seed` — see this file's module doc for
 * the full method (scalar field choice, bounded region, bidirectional crest
 * walk, closure, simplification, confidence).
 *
 * @throws {NoRidgeFoundError} if no ridge locus exists within the bounded
 * search region around `seed`.
 * @throws {NoClosureError} if a ridge is found but the walk never closes
 * into a loop.
 */
export function proposeMarginLoop(
  mesh: IndexedMesh,
  hm: HalfedgeMesh,
  curvature: CurvatureResult,
  seed: SurfacePoint,
  opts: ProposeMarginLoopOptions = {},
): ProposeMarginLoopResult {
  const searchRadiusMm = opts.searchRadiusMm ?? MARGIN_SEARCH_RADIUS_MM;
  const walkRadiusMm = opts.walkRadiusMm ?? MARGIN_WALK_RADIUS_MM;
  const minRidgeStrength = opts.minRidgeStrength ?? MARGIN_MIN_RIDGE_STRENGTH;
  const closureToleranceMm = opts.closureToleranceMm ?? MARGIN_CLOSURE_TOLERANCE_MM;
  const lookaheadSteps = opts.lookaheadSteps ?? MARGIN_LOOKAHEAD_STEPS;
  const maxStepsPerDirection = opts.maxStepsPerDirection ?? MARGIN_MAX_WALK_STEPS;
  const anchorAngleBudgetRad = opts.anchorAngleBudgetRad ?? MARGIN_ANCHOR_ANGLE_BUDGET_RAD;
  const anchorMaxSpacingMm = opts.anchorMaxSpacingMm ?? MARGIN_ANCHOR_MAX_SPACING_MM;

  if (searchRadiusMm <= 0 || !Number.isFinite(searchRadiusMm)) {
    throw new RangeError(`proposeMarginLoop: searchRadiusMm must be finite and > 0, got ${searchRadiusMm}`);
  }
  if (walkRadiusMm <= 0 || !Number.isFinite(walkRadiusMm)) {
    throw new RangeError(`proposeMarginLoop: walkRadiusMm must be finite and > 0, got ${walkRadiusMm}`);
  }

  // Step 2 (locate): bounded region FROM THE SEED — see MARGIN_SEARCH_RADIUS_MM's doc.
  // `findRidgeStart` locates the nearest qualifying vertex AND refines it to
  // the strongest vertex within that SAME connected component — see its doc.
  const locateRegion = boundedVertexRegion(mesh, hm, seed, searchRadiusMm);
  const ridgeStart = findRidgeStart(mesh, hm, curvature, locateRegion, minRidgeStrength);
  if (ridgeStart === null) {
    throw new NoRidgeFoundError(searchRadiusMm, minRidgeStrength);
  }

  // Step 3 (walk): a SEPARATE, larger bounded region FROM THE RIDGE START —
  // see MARGIN_WALK_RADIUS_MM's doc for why this must be independent of
  // (and larger than) the locate-step region above.
  const walkRegion = boundedVertexRegion(mesh, hm, surfacePointAtVertex(mesh, hm, ridgeStart), walkRadiusMm);
  const { loop, closureDeviationMm } = walkRidge(mesh, hm, curvature, walkRegion, ridgeStart, {
    minRidgeStrength,
    closureToleranceMm,
    lookaheadSteps,
    maxStepsPerDirection,
    walkRadiusMm,
  });

  const anchorVertices = simplifyRidgeLoopIndices(mesh, loop, anchorAngleBudgetRad, anchorMaxSpacingMm);
  // Map each anchor VERTEX back to its position within `loop` (for
  // `segmentConfidence`'s sub-path averaging) — `simplifyRidgeLoopIndices`
  // always returns loop-order vertices, so a single forward scan suffices.
  const anchorLoopIndices: number[] = [];
  {
    let searchFrom = 0;
    for (const av of anchorVertices) {
      let idx = -1;
      for (let i = searchFrom; i < loop.length; i++) {
        if (loop[i] === av) {
          idx = i;
          break;
        }
      }
      if (idx === -1) {
        for (let i = 0; i < searchFrom; i++) {
          if (loop[i] === av) {
            idx = i;
            break;
          }
        }
      }
      anchorLoopIndices.push(idx);
      searchFrom = idx + 1;
    }
  }

  const background = backgroundRidgeStrength(curvature, walkRegion, minRidgeStrength);
  const confidence = segmentConfidence(curvature, loop, anchorLoopIndices, background);
  const anchors = anchorVertices.map((v) => surfacePointAtVertex(mesh, hm, v));

  return {
    anchors,
    closed: true,
    segmentConfidence: confidence,
    walkVertexCount: loop.length,
    closureDeviationMm,
    searchRadiusMm,
  };
}
