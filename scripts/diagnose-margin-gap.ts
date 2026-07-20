// scripts/diagnose-margin-gap.ts
//
// Fix batch (Phase 3 Task 4 review), item 2: a non-closure diagnostic for
// `proposeMarginLoop`'s one documented real-fixture limitation (Task 4's
// report, ".superpowers/sdd/p3-task-4-report.md" — "one of the two central-
// incisor candidates does not close with default parameters ... closest
// approach ~1.6mm"). This script is a DIAGNOSTIC TOOL, not a test: it loads
// the real arch-case-01 upperjaw, reproduces the report's own anterior
// cluster survey (k2 < -MARGIN_MIN_RIDGE_STRENGTH threshold sweep,
// restricted to the anterior region) to locate the two real, ADJACENT
// central-incisor-position ridge clusters (the "11"/"21" candidates), seeds
// `proposeMarginLoop` on the one that does NOT close, catches the resulting
// `NoClosureError`, and profiles kappa2 (the walk's own scalar field) along
// the shortest mesh-graph path between the two directions' dead-end front
// vertices — the actual gap the walk could not bridge.
//
// Run with:
//   npx tsx scripts/diagnose-margin-gap.ts
//
// This does NOT change any kernel algorithm/behavior: `NoClosureError`
// gained two OPTIONAL diagnostic fields (`frontAVertex`/`frontBVertex`,
// marginRidge.ts) so this script doesn't have to re-implement the walk to
// find where it stalled — see that class's own doc for why this is safe
// (only populated on the already-failing, non-closing path; the golden's
// own successful `proposeMargin` call never constructs this error).
//
// ---------------------------------------------------------------------------
// VERDICT (recorded here after actually running this script — see its own
// console output, and the "Fix: T4 review items + gap diagnostic" section
// appended to .superpowers/sdd/p3-task-4-report.md for the full numbers):
//
// CREST VANISHES — a genuine scan/anatomy limitation, not a
// threshold-adjacent tuning issue. The non-closing candidate is the
// 820-vertex anterior cluster at ambient centroid x~-4.83 (NoClosureError,
// closestApproach 1.6627mm, matching the report's "~1.6mm" almost exactly).
// Along the 51-vertex shortest graph path between its two dead-end fronts
// (5.38mm graph length), `k2` does NOT merely dip just past
// `-MARGIN_MIN_RIDGE_STRENGTH` (-3 mm^-1) — it crosses all the way through
// background and into slightly POSITIVE territory over a genuine
// multi-vertex stretch in the middle of the path (measured: `k2` in
// [-30.147, +0.891] mm^-1 across the path; the positive/near-zero run sits
// around ambient x in [-3.5, -2.1], y~-19.4 to -19.8 mm, comfortably more
// gingival than either neighboring cluster's own centroid y). 29/51 path
// vertices fail to qualify, and the failing stretch is not a thin one- or
// two-vertex threshold graze — it is a real, multi-mm run where the
// concave crease itself is measurably ABSENT from the curvature field, not
// merely weak. This location sits between the failing candidate's own
// cluster (x~-4.83) and the small, separate 407-vertex cluster nearer the
// midline (x~0.45) — an interproximal-embrasure/contact-point region where
// a real intraoral scanner routinely cannot see the true margin (occluded
// by the adjacent tooth or gingival papilla). Conclusion: this is a
// genuine real-scan coverage limitation at this one interproximal contact,
// not a mistunable parameter — flagged for Task 6 (validation)/Task 8
// (dentist-hand-traced accuracy benchmarking) per the report, which should
// investigate with additional real fixtures rather than retuning
// `MARGIN_MIN_RIDGE_STRENGTH`/`MARGIN_LOOKAHEAD_STEPS` against this one
// case.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStl } from '@dqcad/io';
import {
  intake,
  buildHalfedge,
  computeCurvature,
  surfacePointAtVertex,
  proposeMarginLoop,
  oneRingVertices,
  NoClosureError,
  MARGIN_MIN_RIDGE_STRENGTH,
  type IndexedMesh,
  type HalfedgeMesh,
} from '@dqcad/kernel';
import type { CurvatureResult } from '@dqcad/kernel';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const ARCH_UPPERJAW_PATH = 'test-fixtures/real-scans/arch-case-01/arch-case-01-upperjaw.stl';

// The golden's own fixed seed (scripts/kernel-ops-lib.ts) — the "tooth21"-
// position central-incisor candidate that DOES close cleanly (this task's
// report). Used here only to identify which of the anterior clusters below
// is the "closing" (golden) one, so it can be excluded before the direct
// probe below tries every OTHER anterior cluster and asks
// `proposeMarginLoop` itself which one fails to close (ambient
// cluster-to-cluster proximity turned out NOT to be a reliable way to
// guess this — see the pairwise-gap note further down).
const GOLDEN_SEED_AMBIENT: readonly [number, number, number] = [6.675659656524658, -17.737689971923828, 10.945829391479492];

// The report's own anterior-region bbox (the threshold sweep that located
// the 4 real shoulder preps, FDI 12/11/21/22).
const ANTERIOR_BBOX = { xMin: -15.6, xMax: 19.3, yMin: -20, yMax: -8.7 };

// Minimum component size to count as a real shoulder-prep cluster (not
// smaller natural-anatomy concave features) — comfortably below the
// report's smallest measured real cluster (820 vertices).
const MIN_CLUSTER_SIZE = 400;

function vertexPos(mesh: IndexedMesh, v: number): [number, number, number] {
  return [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!];
}

function dist3(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function loadUpperjawMesh(): IndexedMesh {
  const bytes = readFileSync(join(repoRoot, ARCH_UPPERJAW_PATH));
  const { soup } = parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return intake({ kind: 'soup', soup }).mesh;
}

function qualifies(curvature: CurvatureResult, v: number): boolean {
  return curvature.isBoundary[v] === 0 && curvature.k2[v]! < -MARGIN_MIN_RIDGE_STRENGTH;
}

/** Connected-component flood fill over EVERY `k2`-qualifying vertex in the
 * whole mesh (mirrors `findRidgeStart`'s own component-BFS semantics, see
 * marginRidge.ts) — not restricted to the anterior bbox during the BFS
 * itself (a component's own extent is a fact about the mesh, not about
 * where we later choose to look for it); the bbox is only used afterward to
 * pick out the anterior teeth from whatever else this finds elsewhere on
 * the arch. */
function findQualifyingComponents(mesh: IndexedMesh, hm: HalfedgeMesh, curvature: CurvatureResult): number[][] {
  const vertexCount = mesh.positions.length / 3;
  const visited = new Uint8Array(vertexCount);
  const components: number[][] = [];
  for (let v = 0; v < vertexCount; v++) {
    if (visited[v] || !qualifies(curvature, v)) continue;
    const component: number[] = [];
    const stack = [v];
    visited[v] = 1;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      component.push(cur);
      for (const nb of oneRingVertices(hm, cur)) {
        if (visited[nb] || !qualifies(curvature, nb)) continue;
        visited[nb] = 1;
        stack.push(nb);
      }
    }
    components.push(component);
  }
  return components;
}

function centroid(mesh: IndexedMesh, component: readonly number[]): [number, number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const v of component) {
    const p = vertexPos(mesh, v);
    x += p[0];
    y += p[1];
    z += p[2];
  }
  return [x / component.length, y / component.length, z / component.length];
}

/** Minimum ambient distance between any vertex of `a` and any vertex of `b`
 * (brute force — component sizes here are ~1-2k vertices each, so this is a
 * few million distance evaluations, fine for a one-shot diagnostic). */
function minInterComponentDistance(mesh: IndexedMesh, a: readonly number[], b: readonly number[]): number {
  let best = Infinity;
  for (const va of a) {
    const pa = vertexPos(mesh, va);
    for (const vb of b) {
      const d = dist3(pa, vertexPos(mesh, vb));
      if (d < best) best = d;
    }
  }
  return best;
}

/** Strongest (most negative k2) vertex in a component — same "refine to
 * strongest" rule `findRidgeStart` applies (marginRidge.ts), used here to
 * pick a representative seed vertex for the non-closing candidate. */
function strongestVertex(curvature: CurvatureResult, component: readonly number[]): number {
  let best = component[0]!;
  let bestK2 = curvature.k2[best]!;
  for (const v of component) {
    const k2 = curvature.k2[v]!;
    if (k2 < bestK2) {
      best = v;
      bestK2 = k2;
    }
  }
  return best;
}

/** Plain Dijkstra (ambient 3D edge length) between two vertices, bounded to
 * `radiusMm` of `from` for speed (the fronts this script investigates are
 * only ever ~1-2mm apart) — returns the ordered vertex path, `from` first,
 * `to` last. Deliberately NOT `boundedVertexRegion` (marginRidge.ts): that
 * function is seeded from a `SurfacePoint`/triangle and doesn't return a
 * path, only a distance map — this diagnostic needs the actual path to
 * profile kappa2 along it. */
function shortestVertexPath(mesh: IndexedMesh, hm: HalfedgeMesh, from: number, to: number, radiusMm: number): number[] {
  const dist = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, number>();
  const visited = new Set<number>();
  for (;;) {
    let cur = -1;
    let curDist = Infinity;
    for (const [v, d] of dist) {
      if (!visited.has(v) && d < curDist) {
        cur = v;
        curDist = d;
      }
    }
    if (cur === -1) throw new Error(`shortestVertexPath: no path found from ${from} to ${to} within ${radiusMm}mm`);
    if (cur === to) break;
    visited.add(cur);
    const pCur = vertexPos(mesh, cur);
    for (const nb of oneRingVertices(hm, cur)) {
      if (visited.has(nb)) continue;
      const cand = curDist + dist3(pCur, vertexPos(mesh, nb));
      if (cand > radiusMm) continue;
      const existing = dist.get(nb);
      if (existing === undefined || cand < existing) {
        dist.set(nb, cand);
        prev.set(nb, cur);
      }
    }
  }
  const path: number[] = [to];
  let cur = to;
  while (cur !== from) {
    cur = prev.get(cur)!;
    path.push(cur);
  }
  path.reverse();
  return path;
}

function main(): void {
  console.log('[diagnose-margin-gap] loading arch-case-01 upperjaw...');
  const mesh = loadUpperjawMesh();
  const hm = buildHalfedge(mesh);
  const curvature = computeCurvature(mesh, hm);

  console.log('[diagnose-margin-gap] surveying k2-qualifying connected components...');
  const allComponents = findQualifyingComponents(mesh, hm, curvature);
  const bigComponents = allComponents.filter((c) => c.length >= MIN_CLUSTER_SIZE);
  const anteriorComponents = bigComponents.filter((c) => {
    const [cx, cy] = centroid(mesh, c);
    return cx >= ANTERIOR_BBOX.xMin && cx <= ANTERIOR_BBOX.xMax && cy >= ANTERIOR_BBOX.yMin && cy <= ANTERIOR_BBOX.yMax;
  });
  console.log(
    `[diagnose-margin-gap] ${allComponents.length} total qualifying components, ${bigComponents.length} >= ${MIN_CLUSTER_SIZE} vertices, ` +
      `${anteriorComponents.length} in the anterior bbox. Sizes: ${anteriorComponents.map((c) => c.length).join('/')} ` +
      '(report: 1781/820/1211/1001 for the 4 real shoulder preps FDI 12/11/21/22).',
  );
  if (anteriorComponents.length < 4) {
    console.warn(
      `[diagnose-margin-gap] WARNING: expected at least 4 anterior clusters (FDI 12/11/21/22), found ${anteriorComponents.length} — ` +
        'the identification below may not match the report 1:1; investigate before trusting the verdict.',
    );
  }

  // Identify the "closing" (golden) cluster: the anterior component nearest
  // the golden's own fixed seed.
  let closingIndex = -1;
  let closingDist = Infinity;
  anteriorComponents.forEach((c, i) => {
    const d = Math.min(...c.map((v) => dist3(vertexPos(mesh, v), GOLDEN_SEED_AMBIENT)));
    if (d < closingDist) {
      closingDist = d;
      closingIndex = i;
    }
  });
  console.log(`[diagnose-margin-gap] closing (golden) cluster: index ${closingIndex}, ${closingDist.toFixed(3)}mm from the golden seed.`);

  // Pairwise minimum inter-cluster distance — printed for context. NOTE
  // (verified while building this script): the fixture's GLOBALLY tightest
  // anterior gap (~0.27mm) and the gap immediately adjacent to it (~0.14mm)
  // do NOT involve the golden cluster at all — they sit between other,
  // unrelated anterior clusters (canine/lateral-incisor-position pairs
  // elsewhere in the bbox). Ambient cluster-to-cluster proximity is
  // therefore NOT a reliable way to pick out "the other central-incisor
  // candidate" — see the direct probe below instead, which just asks each
  // candidate whether `proposeMarginLoop` actually closes it.
  for (let i = 0; i < anteriorComponents.length; i++) {
    for (let j = i + 1; j < anteriorComponents.length; j++) {
      const gap = minInterComponentDistance(mesh, anteriorComponents[i]!, anteriorComponents[j]!);
      const [cix, ciy] = centroid(mesh, anteriorComponents[i]!);
      const [cjx, cjy] = centroid(mesh, anteriorComponents[j]!);
      console.log(
        `[diagnose-margin-gap] cluster ${i} (centroid x=${cix.toFixed(2)}, y=${ciy.toFixed(2)}) <-> cluster ${j} ` +
          `(centroid x=${cjx.toFixed(2)}, y=${cjy.toFixed(2)}): gap ${gap.toFixed(3)}mm`,
      );
    }
  }

  // Direct probe (the robust way to find "the failing central-incisor
  // proposal", rather than guessing from ambient geometry alone): seed
  // `proposeMarginLoop` at each NON-golden anterior cluster's own strongest
  // vertex and record which one(s) throw `NoClosureError`. This task's
  // report describes exactly ONE non-golden anterior candidate failing to
  // close (closest approach ~1.6mm) — this loop verifies that directly
  // against the current kernel code, rather than assuming it.
  console.log('[diagnose-margin-gap] probing every non-golden anterior cluster directly...');
  let failingIndex = -1;
  let closureError: NoClosureError | null = null;
  for (let i = 0; i < anteriorComponents.length; i++) {
    if (i === closingIndex) continue;
    const component = anteriorComponents[i]!;
    const seedVertex = strongestVertex(curvature, component);
    const seed = surfacePointAtVertex(mesh, hm, seedVertex);
    try {
      const result = proposeMarginLoop(mesh, hm, curvature, seed);
      console.log(`[diagnose-margin-gap]   cluster ${i} (${component.length} vertices): CLOSED (${result.anchors.length} anchors, ${result.walkVertexCount} walked vertices).`);
    } catch (e) {
      if (!(e instanceof NoClosureError)) throw e;
      console.log(
        `[diagnose-margin-gap]   cluster ${i} (${component.length} vertices): NoClosureError ` +
          `(closestApproach=${e.closureDeviationMm.toFixed(4)}mm, stepsTaken=${e.stepsTaken}) — THE NON-CLOSING CANDIDATE.`,
      );
      if (failingIndex !== -1) {
        console.warn(`[diagnose-margin-gap] WARNING: more than one cluster failed to close (previous: ${failingIndex}, now: ${i}) — investigate.`);
      }
      failingIndex = i;
      closureError = e;
    }
  }
  if (failingIndex === -1 || closureError === null) {
    console.log('[diagnose-margin-gap] every non-golden anterior candidate closed cleanly — no non-closing candidate found on this run; nothing further to diagnose.');
    return;
  }
  const failingComponent = anteriorComponents[failingIndex]!;
  const [fx, fy, fz] = centroid(mesh, failingComponent);
  console.log(
    `[diagnose-margin-gap] non-closing candidate confirmed: cluster ${failingIndex} (${failingComponent.length} vertices, ` +
      `centroid x=${fx.toFixed(2)}, y=${fy.toFixed(2)}, z=${fz.toFixed(2)}).`,
  );

  console.log(
    `[diagnose-margin-gap] caught NoClosureError: closestApproach=${closureError.closureDeviationMm.toFixed(4)}mm, ` +
      `closureToleranceMm=${closureError.closureToleranceMm}, stepsTaken=${closureError.stepsTaken}, ` +
      `frontAVertex=${closureError.frontAVertex}, frontBVertex=${closureError.frontBVertex}.`,
  );
  if (closureError.frontAVertex === undefined || closureError.frontBVertex === undefined) {
    throw new Error('diagnose-margin-gap: NoClosureError did not carry both front vertices (one direction never got established) — cannot profile a gap.');
  }
  const frontA = closureError.frontAVertex;
  const frontB = closureError.frontBVertex;
  console.log(
    `[diagnose-margin-gap] front A: vertex ${frontA}, pos=${vertexPos(mesh, frontA).map((c) => c.toFixed(3)).join(',')}, k2=${curvature.k2[frontA]!.toFixed(3)}`,
  );
  console.log(
    `[diagnose-margin-gap] front B: vertex ${frontB}, pos=${vertexPos(mesh, frontB).map((c) => c.toFixed(3)).join(',')}, k2=${curvature.k2[frontB]!.toFixed(3)}`,
  );
  console.log(`[diagnose-margin-gap] ambient front-to-front distance: ${dist3(vertexPos(mesh, frontA), vertexPos(mesh, frontB)).toFixed(4)}mm`);

  console.log('[diagnose-margin-gap] computing shortest graph path between the two dead-end fronts...');
  const path = shortestVertexPath(mesh, hm, frontA, frontB, 10);
  let pathLengthMm = 0;
  for (let i = 1; i < path.length; i++) {
    pathLengthMm += dist3(vertexPos(mesh, path[i - 1]!), vertexPos(mesh, path[i]!));
  }
  console.log(`[diagnose-margin-gap] shortest path: ${path.length} vertices, ${pathLengthMm.toFixed(4)}mm graph length.`);
  console.log('[diagnose-margin-gap] kappa2 profile along the path (vertex, x, y, z, k2, qualifies):');

  let maxK2OnPath = -Infinity;
  let minK2OnPath = Infinity;
  let disqualifyingCount = 0;
  // Longest CONSECUTIVE run of disqualifying path vertices, and the
  // weakest (largest/least-negative) k2 within that run — distinguishes a
  // genuine multi-vertex hole in the ridge (many consecutive non-qualifying
  // vertices, k2 well past threshold toward background/positive) from an
  // isolated single-vertex threshold graze (a short run, k2 only just past
  // -MARGIN_MIN_RIDGE_STRENGTH).
  let longestRun = 0;
  let longestRunWeakestK2 = -Infinity;
  let curRun = 0;
  let curRunWeakestK2 = -Infinity;
  for (const v of path) {
    const [x, y, z] = vertexPos(mesh, v);
    const k2 = curvature.k2[v]!;
    const q = qualifies(curvature, v);
    if (!q) {
      disqualifyingCount++;
      curRun++;
      curRunWeakestK2 = Math.max(curRunWeakestK2, k2);
    } else {
      if (curRun > longestRun) {
        longestRun = curRun;
        longestRunWeakestK2 = curRunWeakestK2;
      }
      curRun = 0;
      curRunWeakestK2 = -Infinity;
    }
    if (k2 > maxK2OnPath) maxK2OnPath = k2;
    if (k2 < minK2OnPath) minK2OnPath = k2;
    console.log(`  v=${v}\tx=${x.toFixed(3)}\ty=${y.toFixed(3)}\tz=${z.toFixed(3)}\tk2=${k2.toFixed(3)}\tqualifies=${q}`);
  }
  if (curRun > longestRun) {
    longestRun = curRun;
    longestRunWeakestK2 = curRunWeakestK2;
  }
  console.log(
    `[diagnose-margin-gap] path k2 range: [${minK2OnPath.toFixed(3)}, ${maxK2OnPath.toFixed(3)}] mm^-1 (threshold: k2 < -${MARGIN_MIN_RIDGE_STRENGTH}), ` +
      `${disqualifyingCount}/${path.length} path vertices disqualify. Longest consecutive disqualifying run: ${longestRun} vertices ` +
      `(weakest k2 in that run: ${longestRunWeakestK2.toFixed(3)} mm^-1).`,
  );

  // Verdict rule: a genuine multi-vertex run (>= 4 consecutive vertices,
  // comfortably more than one noisy vertex) whose weakest k2 clears well
  // past threshold into background/positive territory (> -1 mm^-1) means
  // the crest is genuinely ABSENT over that stretch, not merely
  // under-qualifying by a small margin.
  const crestVanishes = longestRun >= 4 && longestRunWeakestK2 > -1;
  const verdict = crestVanishes
    ? `CREST VANISHES — the longest disqualifying run (${longestRun} consecutive vertices, weakest k2 ${longestRunWeakestK2.toFixed(3)} mm^-1, well past background) is a genuine multi-vertex hole in the ridge, not a threshold graze — scan/anatomy limitation: the margin is genuinely obscured over this stretch (likely an interproximal contact/embrasure the scanner could not see under).`
    : `THRESHOLD-ADJACENT — the longest disqualifying run (${longestRun} vertices, weakest k2 ${longestRunWeakestK2.toFixed(3)} mm^-1) stays close to -${MARGIN_MIN_RIDGE_STRENGTH} — the crest persists geometrically but disqualifies marginally; a future tuning target, not a scan limitation.`;
  console.log(`[diagnose-margin-gap] VERDICT: ${verdict}`);
  const midVertex = path[Math.floor(path.length / 2)]!;
  const [midX, midY, midZ] = vertexPos(mesh, midVertex);
  console.log(
    `[diagnose-margin-gap] anatomical location: path midpoint (vertex ${midVertex}) at x=${midX.toFixed(2)}, y=${midY.toFixed(2)}, z=${midZ.toFixed(2)} ` +
      `— between the failing cluster's own centroid (x=${fx.toFixed(2)}) and the small midline-adjacent cluster (x~0.45); ` +
      'y here is more gingival/negative than either neighboring cluster centroid — consistent with an interproximal-embrasure contact region between two adjacent anterior teeth.',
  );
}

main();
