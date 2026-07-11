// packages/io/src/ply/plan.ts
//
// Turns a parsed `PlyHeader` into a "read plan": which element is the
// vertex element, which of its properties map to x/y/z, nx/ny/nz,
// red/green/blue (and which are unrecognized and must be skipped); which
// element is the face element and which of its properties is the
// vertex-index list (and which are unrecognized and must be skipped); and
// which whole elements are unrecognized and must be skipped entirely.
//
// This is the shared "what does each property mean" logic used by BOTH
// the binary reader and the ASCII reader — the two readers differ only in
// their low-level byte/token mechanics, never in property-to-role
// resolution, so that resolution lives here exactly once.
//
// The classic PLY trap this package's brief calls out by name: an
// unrecognized property (or an unrecognized whole element) can never be
// skipped by just "moving on to the next property name" — a `property
// list <count-type> <item-type> <name>` has a PER-ROW byte width (its
// count is data, not header metadata), so skipping it correctly requires
// reading that row's count and computing the skip width from it, every
// single row. This module only decides WHAT to skip; binary.ts/ascii.ts
// each implement the actual skip mechanics for their own encoding.

import { MalformedSyntaxError } from '../types.ts';
import type { ParseDiagnostics } from '../types.ts';
import type { PlyElementSpec, PlyHeader, PlyProperty } from './types.ts';

export type VertexRole =
  | 'x'
  | 'y'
  | 'z'
  | 'nx'
  | 'ny'
  | 'nz'
  | 'red'
  | 'green'
  | 'blue'
  | null;

export interface VertexPlan {
  readonly elementIndex: number;
  /** Same length/order as `header.elements[elementIndex].properties`;
   * `null` for a property that isn't consumed into `positions`/`normals`/
   * `colors` (either unrecognized, or a partial normal/color group — see
   * module doc: a group only counts once ALL of its members are present). */
  readonly roleByPropertyIndex: readonly VertexRole[];
  readonly hasNormals: boolean;
  readonly hasColors: boolean;
}

export interface FacePlan {
  readonly elementIndex: number;
  /** Index, within `header.elements[elementIndex].properties`, of the
   * `vertex_indices` (or legacy `vertex_index`) list property. */
  readonly indicesPropertyIndex: number;
}

export interface PlyPlan {
  readonly vertex: VertexPlan;
  readonly face: FacePlan | null;
}

const VERTEX_INDEX_PROPERTY_NAMES: ReadonlySet<string> = new Set(['vertex_indices', 'vertex_index']);

function findElementIndex(header: PlyHeader, name: string): number {
  return header.elements.findIndex((e) => e.name === name);
}

/**
 * Flags an element that declares the same property name more than once —
 * a malformed-but-real-world exporter quirk, not something the PLY spec
 * explicitly forbids in writing, but also not something a from-spec reader
 * has any principled way to disambiguate: every downstream role lookup in
 * this file (`planVertexElement`'s `candidateByName`, `planFaceElement`'s
 * `vertex_indices` search) resolves purely by NAME, so two same-named
 * properties on one element both resolve to the same role, and whichever
 * occurrence a row reader (ascii.ts/binary.ts) decodes LAST silently
 * overwrites the value(s) decoded from the earlier occurrence(s) of that
 * name — every occurrence is still read (the reader must consume its bytes/
 * tokens to stay positioned correctly for the rest of the row), only the
 * last one's value survives into the output.
 *
 * Chosen as a WARNING, not a rejection: unlike a missing x/y/z or a missing
 * vertex-index list property (planVertexElement/planFaceElement, both of
 * which throw — the file is genuinely unreadable without them), a
 * duplicated property name still has a well-defined, deterministic
 * (header-order-driven, not data-dependent) reading — just a surprising
 * one — so rejecting it outright would refuse to load real files that are
 * otherwise perfectly readable over what is almost always a redundant or
 * accidental exporter duplicate, not a corrupt file.
 */
function warnOnDuplicatePropertyNames(element: PlyElementSpec, diagnostics: ParseDiagnostics): void {
  const countByName = new Map<string, number>();
  for (const prop of element.properties) {
    countByName.set(prop.name, (countByName.get(prop.name) ?? 0) + 1);
  }
  const duplicates = [...countByName.entries()].filter(([, count]) => count > 1);
  if (duplicates.length === 0) {
    return;
  }
  const summary = duplicates.map(([name, count]) => `"${name}" x${count}`).join(', ');
  diagnostics.warnings.push(
    `element "${element.name}": propert${duplicates.length === 1 ? 'y is' : 'ies are'} declared more ` +
      `than once (${summary}) — for any duplicated name that resolves to a role this parser reads ` +
      '(x/y/z, nx/ny/nz, red/green/blue, or the face vertex-index list), only the LAST occurrence in ' +
      'header order is kept; values from earlier occurrence(s) of that name are read (to stay ' +
      "correctly positioned within the row) but then overwritten and discarded.",
  );
}

/** Resolves the vertex element's properties to roles, applying the
 * all-or-nothing rule for the (nx, ny, nz) and (red, green, blue) groups:
 * a group is only wired up if every one of its members is present as a
 * scalar property (list properties never fill these roles — a per-vertex
 * list has no meaning as a single coordinate/color channel). Any
 * unmatched or partial-group property is left `null` (skipped) and
 * reported once via `diagnostics`. */
function planVertexElement(
  element: PlyElementSpec,
  elementIndex: number,
  diagnostics: ParseDiagnostics,
): VertexPlan {
  const candidateByName: Partial<Record<string, VertexRole>> = {
    x: 'x',
    y: 'y',
    z: 'z',
    nx: 'nx',
    ny: 'ny',
    nz: 'nz',
    red: 'red',
    green: 'green',
    blue: 'blue',
  };

  const candidateRoles: (VertexRole | null)[] = element.properties.map((prop) =>
    prop.kind === 'scalar' ? (candidateByName[prop.name] ?? null) : null,
  );

  const hasAll = (names: readonly string[]): boolean =>
    names.every((n) => element.properties.some((p) => p.kind === 'scalar' && p.name === n));

  if (!hasAll(['x', 'y', 'z'])) {
    throw new MalformedSyntaxError(
      `vertex element is missing one or more of the required scalar properties x, y, z ` +
        `(has: ${element.properties.map((p) => p.name).join(', ') || '(none)'})`,
    );
  }

  const hasNormals = hasAll(['nx', 'ny', 'nz']);
  const hasColors = hasAll(['red', 'green', 'blue']);

  const roleByPropertyIndex: VertexRole[] = candidateRoles.map((role) => {
    if (role === 'nx' || role === 'ny' || role === 'nz') {
      return hasNormals ? role : null;
    }
    if (role === 'red' || role === 'green' || role === 'blue') {
      return hasColors ? role : null;
    }
    return role;
  });

  const unusedNames = element.properties
    .filter((_, idx) => roleByPropertyIndex[idx] === null)
    .map((p) => `${p.name} (${p.kind === 'list' ? 'list' : p.scalarType})`);
  if (unusedNames.length > 0) {
    diagnostics.warnings.push(
      `vertex element: ${unusedNames.length} propert${unusedNames.length === 1 ? 'y is' : 'ies are'} ` +
        `present but not used by this parser (skipped): ${unusedNames.join(', ')}`,
    );
  }

  return { elementIndex, roleByPropertyIndex, hasNormals, hasColors };
}

function planFaceElement(element: PlyElementSpec, elementIndex: number): FacePlan {
  const indicesPropertyIndex = element.properties.findIndex(
    (p) => p.kind === 'list' && VERTEX_INDEX_PROPERTY_NAMES.has(p.name),
  );
  if (indicesPropertyIndex === -1) {
    throw new MalformedSyntaxError(
      'face element has no "vertex_indices" (or legacy "vertex_index") list property — cannot build ' +
        'mesh indices from this file',
    );
  }
  return { elementIndex, indicesPropertyIndex };
}

/** Names (not values) of a face element's properties that this parser
 * doesn't read into `indices` — reported once as a diagnostics note per
 * the brief's "texcoords may be skipped with a diagnostic note" guardrail
 * (generalized to any unrecognized face property, not just texcoord). */
function faceExtraPropertyNames(element: PlyElementSpec, indicesPropertyIndex: number): string[] {
  return element.properties
    .filter((_, idx) => idx !== indicesPropertyIndex)
    .map((p: PlyProperty) =>
      p.kind === 'list' ? `${p.name} (list)` : `${p.name} (${p.scalarType})`,
    );
}

/**
 * Builds the read plan for `header`. Throws `MalformedSyntaxError` if
 * there's no vertex element, the vertex element lacks x/y/z, or there IS a
 * face element but it lacks a vertex-index list property — all three make
 * it impossible to produce a `PlyMesh`. A missing face element is NOT an
 * error (a point-cloud PLY is valid; `PlyPlan.face` is `null` and the
 * caller emits `faceCount: 0, indices: new Uint32Array(0)`).
 *
 * Also pushes diagnostics for unrecognized whole elements and
 * unrecognized/partial properties on the vertex and face elements — done
 * here (header-only) rather than in the body readers so a single warning
 * is emitted regardless of how many rows the element/property actually
 * has, and so the warning fires even for a 0-row element.
 */
export function planPlyHeader(header: PlyHeader, diagnostics: ParseDiagnostics): PlyPlan {
  // Checked for every element (vertex, face, and any skipped/unrecognized
  // one) before the vertex/face-specific planning below — a duplicate is a
  // property-list-shape problem, independent of whether this parser even
  // reads that element's values.
  for (const element of header.elements) {
    warnOnDuplicatePropertyNames(element, diagnostics);
  }

  const vertexIndex = findElementIndex(header, 'vertex');
  if (vertexIndex === -1) {
    throw new MalformedSyntaxError(
      `PLY header has no "vertex" element (found: ${header.elements.map((e) => e.name).join(', ') || '(none)'})`,
    );
  }
  const vertex = planVertexElement(header.elements[vertexIndex]!, vertexIndex, diagnostics);

  const faceIndex = findElementIndex(header, 'face');
  let face: FacePlan | null = null;
  if (faceIndex !== -1) {
    const faceElement = header.elements[faceIndex]!;
    face = planFaceElement(faceElement, faceIndex);
    const extra = faceExtraPropertyNames(faceElement, face.indicesPropertyIndex);
    if (extra.length > 0) {
      diagnostics.warnings.push(
        `face element: ${extra.length} propert${extra.length === 1 ? 'y is' : 'ies are'} present but ` +
          `not used by this parser (skipped): ${extra.join(', ')}`,
      );
    }
  }

  header.elements.forEach((element, index) => {
    if (index === vertexIndex || index === faceIndex) {
      return;
    }
    diagnostics.warnings.push(
      `element "${element.name}" (${element.count} row(s), ${element.properties.length} ` +
        'property/ies) is not a recognized element (only "vertex" and "face" are read) — skipped ' +
        'entirely',
    );
  });

  return { vertex, face };
}
