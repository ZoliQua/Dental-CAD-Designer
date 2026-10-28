// packages/kernel/src/mesh/edgeLoop.ts
//
// Phase 10 Task 4: is an ordered vertex list a closed edge loop of a mesh?
// Shared by the cervical fit (anatomy/cervicalFit.ts) and the shell's trim
// along the fitted ring (shell/shell.ts), and by the tooth-library loader's
// check of a template's declared cervical ring.
import type { IndexedMesh } from './types.ts';

/**
 * Why `ring` is NOT a closed edge loop of `mesh` (distinct, in-range vertex
 * indices, each consecutive pair — and the last to the first — joined by a
 * mesh edge), or `null` when it is. Shared with the shell's ring trim.
 */
export function closedEdgeLoopProblem(mesh: IndexedMesh, ring: readonly number[]): string | null {
  const vertexCount = mesh.positions.length / 3;
  if (ring.length < 3) return `${ring.length} ring vertex(es)`;
  const seen = new Set<number>();
  for (const r of ring) {
    if (!Number.isInteger(r) || r < 0 || r >= vertexCount || seen.has(r)) return `invalid or repeated ring vertex ${r}`;
    seen.add(r);
  }
  const edges = new Set<number>();
  const key = (a: number, b: number): number => (a < b ? a * vertexCount + b : b * vertexCount + a);
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t]!, b = mesh.indices[t + 1]!, c = mesh.indices[t + 2]!;
    edges.add(key(a, b));
    edges.add(key(b, c));
    edges.add(key(c, a));
  }
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    if (!edges.has(key(a, b))) return `ring vertices ${a} → ${b} are not joined by a mesh edge`;
  }
  return null;
}
