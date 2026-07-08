// Imperative render engine — Three.js objects live ONLY under
// apps/client/src/engine/ (lint-enforced: `no-restricted-imports`/boundaries
// forbid `three` anywhere else, and `ui/` must stay geometry-free).
//
// Task 6's real viewer, replacing the Phase 0 / Task 5 placeholder (a
// neutral grid + hemisphere light, full-rebuild-per-sync mesh group — see
// git history for that version). This class is still framework-agnostic —
// NO React imports here — and is mounted imperatively by ui/Viewport.tsx
// via useRef + useEffect; ui/ViewerToolbar.tsx drives the one-shot/reactive
// methods below through engine/viewerController.ts's `getActiveSceneManager`.
//
// ## Incremental render-node sync (vs. Task 5's full rebuild)
//
// `syncRenderNodes` diffs the incoming `RenderNode[]` against the currently
// live `Mesh` entries by id (== the owning SceneNode's id) instead of
// disposing and recreating everything on every call: a node whose id
// persists across syncs keeps its `Mesh`/`BufferGeometry`/material objects
// (avoiding GPU realloc + shader relink + losing the live selection-highlight
// tint), only nodes that disappeared get disposed and nodes that appeared
// get created. The one thing every sync-for-an-existing-node call ALWAYS
// does is mark the position attribute dirty (`needsUpdate = true`) and
// recompute normals/bounds — see `updateEntryGeometry`'s doc for why a
// reference-equality check on `node.positions` is not sufficient here.
//
// ## Transparent render order
//
// Any node with `opacity < 1` gets `material.transparent = true`,
// `material.depthWrite = false`, and `mesh.renderOrder = 1` (opaque meshes
// stay at the default 0, `depthWrite = true`). Skipping the depth WRITE
// (not the depth test) for transparent meshes is what makes two overlapping
// arches at opacity 0.5 both stay visible through each other — with
// depthWrite left on, whichever arch's fragment reaches the depth buffer
// first would occlude the other despite both being translucent. Three's
// renderer already sorts transparent objects back-to-front by (bounding
// sphere) camera distance each frame, which combined with `renderOrder`
// ordering opaque-before-transparent gives a correct-looking result for
// Phase 1's few-mesh scenes.
//
// The wireframe overlay (a `LineSegments` child of each mesh) is its own
// object in Three's render list — being a scene-graph CHILD does not imply
// "draws after its parent." Its `LineBasicMaterial` is always
// `transparent: true` (see `createEntry`), so it always lands in the
// transparent queue; the base mesh only joins that queue when its own
// opacity < 1. When both share the transparent queue, ties in `renderOrder`
// fall through to Three's back-to-front distance sort, which for a mesh and
// its zero-thickness wireframe overlay is essentially a coin flip — so the
// wireframe must be given a strictly higher `renderOrder` than its mesh to
// guarantee it paints on top. `transparentRenderOrders` below is the single
// source of truth for that invariant (also see its own doc for why it's set
// unconditionally, even at opacity 1 where it's numerically true but
// render-inconsequential).
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  type ColorRepresentation,
  Float32BufferAttribute,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  Mesh,
  type MeshMatcapMaterial,
  type MeshStandardMaterial,
  type Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Raycaster,
  Scene,
  Sphere,
  type Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
  WireframeGeometry,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MeasurementKind, MeshRole } from '@dqcad/shared-types';
import type { RenderNode } from './renderNode';
import {
  resolveJawContext,
  standardViewForDigitKey,
  standardViewOffset,
  type StandardView,
} from './standardViews';
import {
  createClinicalLights,
  createMatcapTexture,
  createShadingMaterial,
  type ShadingPreset,
} from './shading';
import {
  DEFAULT_VIEWER_BINDINGS,
  toOrbitControlsMouseMap,
  type ViewerBindings,
} from './viewerBindings';

export type { RenderNode };
export type CameraProjection = 'perspective' | 'orthographic';
export type Theme = 'dark' | 'light';

/** 'select': the existing click-pick-a-SceneNode behavior (`onSelect`).
 * 'measure': a measurement tool (engine/ToolManager.ts) is active — clicks
 * report a candidate mesh + world-space ray via `onMeasurePick` INSTEAD of
 * selecting a node (see `SceneManagerOptions.onMeasurePick`'s doc for why a
 * ray, not a point). */
export type InteractionMode = 'select' | 'measure';

/** What a measurement-mode click reports — SceneManager's Float32 render-
 * copy raycast only ever picks the candidate mesh/ray CHEAPLY; the
 * authoritative Float64 pick point is always computed afterwards by
 * ToolManager.ts via a worker job (this task's brief's central correctness
 * requirement — see ToolManager.ts's module doc). `rayOrigin`/`rayDirection`
 * are in THIS SceneManager's render frame (Float32-safe, re-centered at the
 * case bbox centroid — meshStore.ts's `getWorldOffset()`) — the caller
 * (ui/Viewport.tsx) is responsible for adding that offset back before
 * handing the ray to ToolManager, exactly as it already does for
 * `RenderNode`/mesh positions. */
export interface MeasurePickCandidate {
  nodeId: string;
  rayOrigin: readonly [number, number, number];
  rayDirection: readonly [number, number, number];
}

/** Render-frame (already offset by the caller — see `MeasurePickCandidate`'s
 * doc) points for one measurement's overlay — `points.length` is 2 for
 * `pointToPoint`/`pointToSurface`, 3 for `angle` (vertex = `points[1]`). */
export interface MeasurementRenderData {
  id: string;
  kind: MeasurementKind;
  points: ReadonlyArray<readonly [number, number, number]>;
}

const CAMERA_FOV_DEGREES = 50;
const CAMERA_NEAR_MM = 0.1;
const CAMERA_FAR_MM = 5000;

const GRID_SIZE_MM = 400;
const GRID_DIVISIONS = 40;

/** Plausible half-arch-scale radius (mm) used only for the very first framing
 * before any mesh has loaded — not tied to any real case geometry. */
const DEFAULT_EMPTY_FRAME_RADIUS_MM = 40;
const MIN_FRAME_RADIUS_MM = 1;
/** Multiplier applied to a framed bounding sphere's radius so the subject
 * doesn't touch the viewport edges. */
const FRAME_PADDING = 1.35;
/** A perspective->orthographic (or back) toggle keeps the camera roughly
 * this far out in ortho mode, in multiples of the current frustum half-height
 * — orthographic projection makes camera DISTANCE irrelevant to apparent
 * size, but OrbitControls' dolly/pan math still wants a sane, non-degenerate
 * distance from the target. */
const ORTHO_CAMERA_DISTANCE_FACTOR = 4;

const CLICK_DRAG_THRESHOLD_PX = 5;

const SELECTION_HIGHLIGHT_COLOR = new Color(0x4da3ff); // matches index.css's --color-accent (dark theme)
const SELECTION_HIGHLIGHT_MIX = 0.55;

// Measurement overlay: a warm, high-contrast color distinct from both theme
// backgrounds and the selection highlight (a saturated amber reads clearly
// against the near-black/near-white viewer backgrounds — see THEME_COLORS —
// and against the blue selection tint). `depthTest: false` on both the line
// and point materials (see `createMeasurementEntry`) makes the overlay
// always render on top of mesh geometry, like a HUD — the same reasoning a
// measurement tool in any CAD viewer follows: a pick you can't see through
// the mesh isn't useful mid-measurement.
const MEASUREMENT_COLOR = new Color(0xffb020);
const MEASUREMENT_POINT_SIZE_PX = 8;
/** Higher than every mesh/wireframe renderOrder (see `transparentRenderOrders`
 * — its highest value is 2) so the measurement overlay always paints last. */
const MEASUREMENT_RENDER_ORDER = 10;

interface ThemeColors {
  background: ColorRepresentation;
  gridMain: ColorRepresentation;
  gridSub: ColorRepresentation;
  /** Wireframe-overlay line color — like the grid colors below, this needs
   * a per-theme value rather than one fixed hex: a dark near-black line
   * (right for the light theme's near-white background) is nearly invisible
   * against the dark theme's near-black background, and vice versa. */
  wireframe: ColorRepresentation;
}

// Mirrors src/index.css's --color-bg for each theme — kept in sync by hand
// since SceneManager renders via WebGL, not CSS; if index.css's palette
// changes, update here too (see setTheme's doc).
const THEME_COLORS: Record<Theme, ThemeColors> = {
  dark: { background: 0x1a1a1a, gridMain: 0x666666, gridSub: 0x333333, wireframe: 0x999999 },
  light: { background: 0xf5f5f5, gridMain: 0x999999, gridSub: 0xcfcfcf, wireframe: 0x2b2b2b },
};

interface MeshEntry {
  id: string;
  mesh: Mesh;
  geometry: BufferGeometry;
  material: MeshMatcapMaterial | MeshStandardMaterial;
  /** The material's `color` immediately after creation, before any
   * selection-highlight tint — restored on deselect / re-captured whenever
   * the material is recreated (shading-preset switch). */
  baseColor: Color;
  wireframeMesh: LineSegments;
  wireframeGeometry: WireframeGeometry;
  wireframeMaterial: LineBasicMaterial;
  /** Reference-identity of the index buffer last applied — see
   * `updateEntryGeometry`'s doc; indices, unlike positions, are stable for a
   * node's lifetime in practice, so this is a cheap defensive check. */
  indicesRef: Uint32Array;
  visible: boolean;
  opacity: number;
  /** Whether this entry's geometry currently carries a `color`
   * BufferAttribute (Task 9's heatmap overlay — see `applyColors`) — tracked
   * so `applyColors` only flips `material.vertexColors` (which forces a
   * shader recompile via `needsUpdate`) on an actual on/off TRANSITION,
   * not on every sync while a heatmap stays active. */
  hasColors: boolean;
}

/** One measurement's overlay geometry — see `syncMeasurements`'s doc for
 * why this is fully rebuilt each sync rather than incrementally diffed like
 * `MeshEntry`. */
interface MeasurementEntry {
  line: LineSegments;
  lineGeometry: BufferGeometry;
  lineMaterial: LineBasicMaterial;
  points: Points;
  pointsGeometry: BufferGeometry;
  pointsMaterial: PointsMaterial;
}

export interface SceneManagerOptions {
  /** Called with the click-picked SceneNode id (or `null` on an empty-space
   * click / deselect) — see this file's module doc: SceneManager never talks
   * to engine/caseStore.ts directly, ui/Viewport.tsx bridges the round trip
   * (SceneManager -> onSelect -> caseStore.setSelectedNodeId -> published
   * snapshot -> Viewport's effect -> SceneManager.setSelectedNodeId), the
   * same pattern the document/render-node sync already uses. Without this
   * callback wired, clicks still raycast but nothing becomes highlighted. */
  onSelect?: (nodeId: string | null) => void;
  /** Called instead of `onSelect` while `interactionMode === 'measure'` (see
   * `setInteractionMode`) — see `MeasurePickCandidate`'s doc. Only fires on
   * an actual mesh hit (a measurement-mode click on empty space is simply
   * ignored, unlike a `select`-mode click, which reports `null` to clear
   * the selection — there's nothing analogous to "deselect" mid-measurement). */
  onMeasurePick?: (pick: MeasurePickCandidate) => void;
  initialTheme?: Theme;
  initialProjection?: CameraProjection;
  initialShadingPreset?: ShadingPreset;
  initialWireframeEnabled?: boolean;
  initialViewerBindings?: ViewerBindings;
}

/** Disposes every geometry/material reachable from `root`'s subtree —
 * covers mesh entries (incl. their wireframe-overlay children) AND
 * non-mesh scene objects like GridHelper (a LineSegments subclass with its
 * own geometry/material) that Task 5's placeholder never disposed (the
 * "known Phase 0 GridHelper leak" this task's brief calls out). Lights have
 * neither `geometry` nor `material`; traversal skips them harmlessly.
 * Deliberately does NOT touch any texture a material references (e.g. the
 * shared matcap texture) — `Material.dispose()` never disposes attached
 * textures by Three.js's own design, and the shared matcap texture is
 * disposed exactly once, separately, in `SceneManager.dispose()`. */
function disposeObject3DTree(root: Object3D): void {
  root.traverse((child) => {
    const withResources = child as Partial<Mesh & LineSegments>;
    withResources.geometry?.dispose();
    const material = withResources.material;
    if (!material) return;
    for (const mat of Array.isArray(material) ? material : [material]) {
      mat.dispose();
    }
  });
}

/**
 * The mesh/wireframe-overlay `renderOrder` pair for a given opacity — see
 * the module doc's "Transparent render order" section for why the
 * wireframe MUST outrank its mesh. Factored out as a pure, exported
 * function (rather than left inline in `applyOpacity`) specifically so it's
 * unit-testable without a real `WebGLRenderer`/`HTMLElement`/`ResizeObserver`
 * — `SceneManager` itself can't be constructed under vitest's `node`
 * environment (no DOM, no canvas), but this invariant is just arithmetic on
 * plain numbers and deserves direct coverage.
 *
 * The invariant (`wireframeRenderOrder > meshRenderOrder`) is set
 * unconditionally for every opacity, not only `< 1`. At `opacity === 1` the
 * mesh's material is opaque (`transparent = false`) and so renders in
 * Three's separate OPAQUE queue, which always fully drains before the
 * TRANSPARENT queue the wireframe is always in — meaning the ordering is
 * numerically true but render-inconsequential there (the wireframe already
 * paints on top via the queue split alone). Keeping the invariant
 * unconditional avoids a transient "wrong" pairing during an opacity
 * transition and keeps this function simple to reason about and test.
 */
export function transparentRenderOrders(opacity: number): {
  meshRenderOrder: number;
  wireframeRenderOrder: number;
} {
  const meshRenderOrder = opacity < 1 ? 1 : 0;
  return { meshRenderOrder, wireframeRenderOrder: meshRenderOrder + 1 };
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export class SceneManager {
  private readonly container: HTMLElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly perspectiveCamera: PerspectiveCamera;
  private readonly orthographicCamera: OrthographicCamera;
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private readonly meshGroup: Group;
  private readonly measurementGroup: Group;
  private readonly raycaster = new Raycaster();
  private readonly matcapTexture: Texture;
  private grid: GridHelper;
  private theme: Theme;
  private animationFrameId: number | null = null;
  private disposed = false;

  private readonly meshEntries = new Map<string, MeshEntry>();
  /** Every currently-live node's role, collected in `syncRenderNodes`
   * unconditionally of `node.visible` — deliberately NOT visibility-filtered,
   * unlike `computeBoundingSphere`/`frameAll`/`frameSelection`'s
   * `{ visibleOnly: true }` framing math. `resolveJawContext` (used by
   * `setStandardView`) reads this: hiding the upper jaw shouldn't flip a
   * mixed-arch case's occlusal convention back to lower-jaw-only, since the
   * hidden mesh is still logically part of the case. */
  private currentRoles: MeshRole[] = [];
  private selectedNodeId: string | null = null;
  private readonly measurementEntries = new Map<string, MeasurementEntry>();
  private interactionMode: InteractionMode = 'select';

  private projectionMode: CameraProjection;
  private shadingPreset: ShadingPreset;
  private wireframeEnabled: boolean;
  /** Orthographic frustum half-height, in mm — the ortho analogue of
   * "distance" for framing purposes (see `applyOrthoFrustum`). */
  private orthoHalfHeightMm = DEFAULT_EMPTY_FRAME_RADIUS_MM * FRAME_PADDING;

  private readonly onSelect: ((nodeId: string | null) => void) | undefined;
  private readonly onMeasurePick: ((pick: MeasurePickCandidate) => void) | undefined;
  private pointerDownClientPos: { x: number; y: number } | null = null;

  constructor(container: HTMLElement, options: SceneManagerOptions = {}) {
    this.container = container;
    this.onSelect = options.onSelect;
    this.onMeasurePick = options.onMeasurePick;
    this.theme = options.initialTheme ?? 'dark';
    this.projectionMode = options.initialProjection ?? 'perspective';
    this.shadingPreset = options.initialShadingPreset ?? 'clinical';
    this.wireframeEnabled = options.initialWireframeEnabled ?? false;

    this.scene = new Scene();
    this.scene.background = new Color(THEME_COLORS[this.theme].background);

    this.perspectiveCamera = new PerspectiveCamera(
      CAMERA_FOV_DEGREES,
      1,
      CAMERA_NEAR_MM,
      CAMERA_FAR_MM,
    );
    this.orthographicCamera = new OrthographicCamera(-1, 1, 1, -1, CAMERA_NEAR_MM, CAMERA_FAR_MM);

    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.activeCamera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.mouseButtons = toOrbitControlsMouseMap(
      options.initialViewerBindings ?? DEFAULT_VIEWER_BINDINGS,
    );

    const { hemisphere, directional } = createClinicalLights();
    this.scene.add(hemisphere, directional);

    this.matcapTexture = createMatcapTexture();

    this.grid = this.buildGrid();
    this.scene.add(this.grid);

    this.meshGroup = new Group();
    this.scene.add(this.meshGroup);

    this.measurementGroup = new Group();
    this.scene.add(this.measurementGroup);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.container);
    this.handleResize();

    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('keydown', this.handleKeyDown);

    // Initial framing: a fixed "front" placeholder view of an empty scene —
    // the same role Task 5/Phase 0's hardcoded camera position played, but
    // expressed through the same framing math every other view uses.
    this.applyFraming(new Vector3(0, 0, 0), DEFAULT_EMPTY_FRAME_RADIUS_MM, this.frontDirection());

    this.animate = this.animate.bind(this);
    this.animationFrameId = requestAnimationFrame(this.animate);
  }

  private frontDirection(): Vector3 {
    const [x, y, z] = standardViewOffset('front', 'none');
    return new Vector3(x, y, z);
  }

  private get activeCamera(): PerspectiveCamera | OrthographicCamera {
    return this.projectionMode === 'perspective' ? this.perspectiveCamera : this.orthographicCamera;
  }

  private currentAspect(): number {
    const { clientWidth: width, clientHeight: height } = this.container;
    return width > 0 && height > 0 ? width / height : 1;
  }

  private buildGrid(): GridHelper {
    const colors = THEME_COLORS[this.theme];
    return new GridHelper(GRID_SIZE_MM, GRID_DIVISIONS, colors.gridMain, colors.gridSub);
  }

  // ---------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------

  /** Applies a dark/light theme to the background clear color, the grid,
   * and every live mesh entry's wireframe-overlay line color — called by
   * ui/Viewport.tsx whenever state/appStore.ts's `theme` changes (mirroring
   * the CSS-custom-property-driven UI theme, since the WebGL canvas can't
   * just inherit a CSS variable). */
  setTheme(theme: Theme): void {
    if (theme === this.theme) return;
    this.theme = theme;
    this.scene.background = new Color(THEME_COLORS[theme].background);
    this.scene.remove(this.grid);
    disposeObject3DTree(this.grid);
    this.grid = this.buildGrid();
    this.scene.add(this.grid);
    const wireframeColor = THEME_COLORS[theme].wireframe;
    for (const entry of this.meshEntries.values()) {
      entry.wireframeMaterial.color.set(wireframeColor);
    }
  }

  // ---------------------------------------------------------------------
  // Render-node sync
  // ---------------------------------------------------------------------

  /**
   * Diffs `nodes` against the currently live mesh entries — see this file's
   * module doc for the incremental-vs-full-rebuild rationale. Auto-frames
   * the camera once, the first time any mesh appears in an empty scene (a
   * reasonable default so a fresh import is immediately visible rather than
   * requiring a manual "frame all" click).
   */
  syncRenderNodes(nodes: readonly RenderNode[]): void {
    const hadNoMeshesBefore = this.meshEntries.size === 0;
    const incomingIds = new Set(nodes.map((node) => node.id));

    for (const [id, entry] of this.meshEntries) {
      if (incomingIds.has(id)) continue;
      this.meshGroup.remove(entry.mesh);
      this.disposeEntry(entry);
      this.meshEntries.delete(id);
    }

    const roles: MeshRole[] = [];
    for (const node of nodes) {
      roles.push(node.role);
      let entry = this.meshEntries.get(node.id);
      if (!entry) {
        entry = this.createEntry(node);
        this.meshEntries.set(node.id, entry);
        this.meshGroup.add(entry.mesh);
      } else {
        this.updateEntryGeometry(entry, node);
      }
      entry.visible = node.visible;
      entry.mesh.visible = node.visible;
      this.applyOpacity(entry, node.opacity);
      this.applyColors(entry, node);
      entry.wireframeMesh.visible = this.wireframeEnabled && node.visible;
      if (this.selectedNodeId === node.id) {
        this.applyHighlight(entry, true);
      }
    }
    this.currentRoles = roles;

    if (hadNoMeshesBefore && this.meshEntries.size > 0) {
      this.frameAll();
    }
  }

  private createEntry(node: RenderNode): MeshEntry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(node.positions, 3));
    geometry.setIndex(new BufferAttribute(node.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const material = createShadingMaterial(this.shadingPreset, this.matcapTexture);
    const baseColor = material.color.clone();

    const mesh = new Mesh(geometry, material);
    mesh.name = node.id;

    const wireframeGeometry = new WireframeGeometry(geometry);
    const wireframeMaterial = new LineBasicMaterial({
      color: THEME_COLORS[this.theme].wireframe,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    const wireframeMesh = new LineSegments(wireframeGeometry, wireframeMaterial);
    wireframeMesh.visible = this.wireframeEnabled && node.visible;
    // Initialize both to the same invariant `applyOpacity` maintains from
    // then on (see `transparentRenderOrders`'s doc) — `syncRenderNodes`
    // always calls `applyOpacity` immediately after `createEntry`, so this
    // is belt-and-suspenders rather than load-bearing today, but it means
    // a freshly-created entry is never transiently in a state where the
    // invariant doesn't hold.
    const initialRenderOrders = transparentRenderOrders(node.opacity);
    mesh.renderOrder = initialRenderOrders.meshRenderOrder;
    wireframeMesh.renderOrder = initialRenderOrders.wireframeRenderOrder;
    mesh.add(wireframeMesh);

    return {
      id: node.id,
      mesh,
      geometry,
      material,
      baseColor,
      wireframeMesh,
      wireframeGeometry,
      wireframeMaterial,
      indicesRef: node.indices,
      visible: node.visible,
      opacity: node.opacity,
      hasColors: false,
    };
  }

  /**
   * Updates an EXISTING entry's geometry for a re-synced `node`.
   *
   * `node.positions` is `engine/meshStore.ts`'s `renderPositions` Float32Array
   * — `recenterAll()` mutates its VALUES in place (same array identity)
   * whenever the case's mesh registry membership changes (any register or
   * remove), including for meshes unrelated to the one just added/removed.
   * A reference-equality check (`positionAttribute.array !== node.positions`)
   * therefore CANNOT detect "this mesh got recentered because a sibling
   * mesh was added" — so positions are unconditionally marked dirty and
   * bounds/normals unconditionally recomputed on every sync, for every
   * still-live entry. The reference check below only guards the (currently
   * never-hit, but defensively cheap) case of the array identity itself
   * changing. Indices, in contrast, never change in place — `indicesRef` is
   * enough to skip re-setting the index buffer on the common path.
   */
  private updateEntryGeometry(entry: MeshEntry, node: RenderNode): void {
    if (entry.indicesRef !== node.indices) {
      entry.geometry.setIndex(new BufferAttribute(node.indices, 1));
      entry.indicesRef = node.indices;
    }
    const positionAttribute = entry.geometry.getAttribute('position');
    if (!positionAttribute || positionAttribute.array !== node.positions) {
      entry.geometry.setAttribute('position', new BufferAttribute(node.positions, 3));
    } else {
      positionAttribute.needsUpdate = true;
    }
    entry.geometry.computeVertexNormals();
    entry.geometry.computeBoundingBox();
    entry.geometry.computeBoundingSphere();

    entry.wireframeGeometry.dispose();
    entry.wireframeGeometry = new WireframeGeometry(entry.geometry);
    entry.wireframeMesh.geometry = entry.wireframeGeometry;
  }

  private applyOpacity(entry: MeshEntry, opacity: number): void {
    entry.opacity = opacity;
    entry.material.opacity = opacity;
    const isTransparent = opacity < 1;
    entry.material.transparent = isTransparent;
    entry.material.depthWrite = !isTransparent;
    const { meshRenderOrder, wireframeRenderOrder } = transparentRenderOrders(opacity);
    entry.mesh.renderOrder = meshRenderOrder;
    entry.wireframeMesh.renderOrder = wireframeRenderOrder;
  }

  /**
   * Applies (or clears) `node.colors` (Task 9's surface-distance heatmap —
   * see renderNode.ts's `RenderNode.colors` doc) as a `color`
   * BufferAttribute on `entry`'s geometry, toggling
   * `material.vertexColors` on an actual on/off transition only (see
   * `MeshEntry.hasColors`'s doc — flipping that flag forces a shader
   * recompile via `needsUpdate`, which is unnecessary work to repeat every
   * sync while a heatmap stays active/inactive). The attribute itself IS
   * always re-set while `node.colors` is present (cheap — mirrors
   * `updateEntryGeometry`'s unconditional position-attribute update — and
   * correctly picks up a fresh heatmap run's new colors without needing its
   * own separate "did the buffer change" identity check).
   */
  private applyColors(entry: MeshEntry, node: RenderNode): void {
    if (node.colors) {
      entry.geometry.setAttribute('color', new BufferAttribute(node.colors, 3));
      if (!entry.hasColors) {
        entry.material.vertexColors = true;
        entry.material.needsUpdate = true;
        entry.hasColors = true;
      }
    } else if (entry.hasColors) {
      entry.geometry.deleteAttribute('color');
      entry.material.vertexColors = false;
      entry.material.needsUpdate = true;
      entry.hasColors = false;
    }
  }

  private disposeEntry(entry: MeshEntry): void {
    entry.geometry.dispose();
    entry.material.dispose();
    entry.wireframeGeometry.dispose();
    entry.wireframeMaterial.dispose();
  }

  // ---------------------------------------------------------------------
  // Shading
  // ---------------------------------------------------------------------

  getShadingPreset(): ShadingPreset {
    return this.shadingPreset;
  }

  /** Rebuilds every mesh entry's material for the new preset — geometry
   * (and thus the incremental-sync identity that matters for perf) is left
   * untouched. */
  setShadingPreset(preset: ShadingPreset): void {
    if (preset === this.shadingPreset) return;
    this.shadingPreset = preset;
    for (const entry of this.meshEntries.values()) {
      const oldMaterial = entry.material;
      const newMaterial = createShadingMaterial(preset, this.matcapTexture);
      // A freshly-created material always defaults to `vertexColors: false`
      // — carry over whether THIS entry currently has a heatmap `color`
      // attribute applied (see `applyColors`'s doc), so switching shading
      // presets mid-heatmap doesn't silently drop the overlay back to the
      // material's flat base color.
      newMaterial.vertexColors = entry.hasColors;
      entry.material = newMaterial;
      entry.baseColor = newMaterial.color.clone();
      entry.mesh.material = newMaterial;
      this.applyOpacity(entry, entry.opacity);
      if (this.selectedNodeId === entry.id) {
        this.applyHighlight(entry, true);
      }
      oldMaterial.dispose();
    }
  }

  isWireframeEnabled(): boolean {
    return this.wireframeEnabled;
  }

  setWireframeEnabled(enabled: boolean): void {
    if (enabled === this.wireframeEnabled) return;
    this.wireframeEnabled = enabled;
    for (const entry of this.meshEntries.values()) {
      entry.wireframeMesh.visible = enabled && entry.visible;
    }
  }

  // ---------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------

  /** Applies (or clears) the click-pick highlight for `nodeId` — driven by
   * ui/Viewport.tsx's round trip through engine/caseStore.ts's published
   * selection (see SceneManagerOptions.onSelect's doc), NOT called directly
   * from the internal raycast handler. */
  setSelectedNodeId(nodeId: string | null): void {
    if (nodeId === this.selectedNodeId) return;
    const previous = this.selectedNodeId ? this.meshEntries.get(this.selectedNodeId) : undefined;
    if (previous) this.applyHighlight(previous, false);
    this.selectedNodeId = nodeId;
    const next = nodeId ? this.meshEntries.get(nodeId) : undefined;
    if (next) this.applyHighlight(next, true);
  }

  getSelectedNodeId(): string | null {
    return this.selectedNodeId;
  }

  private applyHighlight(entry: MeshEntry, selected: boolean): void {
    if (selected) {
      entry.material.color
        .copy(entry.baseColor)
        .lerp(SELECTION_HIGHLIGHT_COLOR, SELECTION_HIGHLIGHT_MIX);
    } else {
      entry.material.color.copy(entry.baseColor);
    }
  }

  // ---------------------------------------------------------------------
  // Measurement (Task 7)
  // ---------------------------------------------------------------------

  /** Switches between ordinary click-to-select and measurement-pick clicks
   * — see `InteractionMode`'s doc. ui/Viewport.tsx drives this from
   * state/toolStore.ts's `activeTool` (non-null -> 'measure'), the same
   * "state says what, engine applies it" direction as `setProjection`/
   * `setShadingPreset`. */
  setInteractionMode(mode: InteractionMode): void {
    this.interactionMode = mode;
  }

  getInteractionMode(): InteractionMode {
    return this.interactionMode;
  }

  /**
   * Rebuilds the measurement overlay (lines connecting each measurement's
   * points, plus point markers) from `measurements`. Deliberately a FULL
   * rebuild every call, unlike `syncRenderNodes`'s incremental diff — a
   * measurement's points never change after it's created (no in-place
   * editing in this task's scope) and the measurement COUNT is always small
   * (a handful of user-placed annotations, not per-vertex mesh data), so the
   * incremental-diff complexity `syncRenderNodes` needs to avoid re-
   * uploading a quarter-million-vertex buffer every case-document change
   * has no payoff here.
   *
   * No text/numbers are ever drawn here (this task's brief: "screen-space
   * HTML overlay, no geometry text") — only lines/points. The numeric
   * label for each measurement is rendered by ui/MeasurementOverlay.tsx as
   * an absolutely-positioned HTML element, using `projectToScreen` below to
   * find where to put it.
   */
  syncMeasurements(measurements: readonly MeasurementRenderData[]): void {
    for (const entry of this.measurementEntries.values()) {
      this.measurementGroup.remove(entry.line, entry.points);
      entry.lineGeometry.dispose();
      entry.lineMaterial.dispose();
      entry.pointsGeometry.dispose();
      entry.pointsMaterial.dispose();
    }
    this.measurementEntries.clear();

    for (const measurement of measurements) {
      this.measurementEntries.set(measurement.id, this.createMeasurementEntry(measurement));
    }
  }

  private createMeasurementEntry(measurement: MeasurementRenderData): MeasurementEntry {
    // `angle`'s 3 points are drawn as two segments meeting at the vertex
    // (points[1]) rather than one polyline through all three, so
    // LineSegments (pairs of endpoints) works uniformly for every
    // measurement kind without a separate LineLoop/Line code path.
    const segments =
      measurement.kind === 'angle' && measurement.points.length === 3
        ? [
            measurement.points[1]!,
            measurement.points[0]!,
            measurement.points[1]!,
            measurement.points[2]!,
          ]
        : [measurement.points[0]!, measurement.points[1]!];

    const lineGeometry = new BufferGeometry();
    lineGeometry.setAttribute('position', new Float32BufferAttribute(segments.flat(), 3));
    const lineMaterial = new LineBasicMaterial({ color: MEASUREMENT_COLOR, depthTest: false });
    const line = new LineSegments(lineGeometry, lineMaterial);
    line.renderOrder = MEASUREMENT_RENDER_ORDER;

    const pointsGeometry = new BufferGeometry();
    pointsGeometry.setAttribute(
      'position',
      new Float32BufferAttribute(measurement.points.flat(), 3),
    );
    const pointsMaterial = new PointsMaterial({
      color: MEASUREMENT_COLOR,
      size: MEASUREMENT_POINT_SIZE_PX,
      sizeAttenuation: false,
      depthTest: false,
    });
    const points = new Points(pointsGeometry, pointsMaterial);
    points.renderOrder = MEASUREMENT_RENDER_ORDER;

    this.measurementGroup.add(line, points);
    return { line, lineGeometry, lineMaterial, points, pointsGeometry, pointsMaterial };
  }

  /**
   * Projects a render-frame (Float32-safe, re-centered — same frame as
   * `MeasurementRenderData.points`) world point to CSS pixel coordinates
   * within the viewport container, for ui/MeasurementOverlay.tsx's
   * absolutely-positioned HTML labels. Returns `null` if the container has
   * no current size (matches `handleResize`'s own guard) or the point
   * projects outside the camera's near/far range (behind the camera, or
   * beyond the far plane) — the caller hides that label rather than
   * pinning it to a meaningless position.
   */
  projectToScreen(point: readonly [number, number, number]): { xPx: number; yPx: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const projected = new Vector3(point[0], point[1], point[2]).project(this.activeCamera);
    if (projected.z < -1 || projected.z > 1) return null; // outside the near/far clip range
    return {
      xPx: ((projected.x + 1) / 2) * rect.width,
      yPx: ((1 - projected.y) / 2) * rect.height,
    };
  }

  private handlePointerDown = (event: PointerEvent): void => {
    this.pointerDownClientPos = { x: event.clientX, y: event.clientY };
  };

  private handlePointerUp = (event: PointerEvent): void => {
    const down = this.pointerDownClientPos;
    this.pointerDownClientPos = null;
    if (!down) return;
    const dx = event.clientX - down.x;
    const dy = event.clientY - down.y;
    // A drag (orbit/pan) also fires pointerdown/up — only treat this as a
    // pick if the pointer barely moved between the two.
    if (Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD_PX) return;
    this.pickAtClientPosition(event.clientX, event.clientY);
  };

  private pickAtClientPosition(clientX: number, clientY: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    );
    this.raycaster.setFromCamera(ndc, this.activeCamera);
    const pickableMeshes = [...this.meshEntries.values()]
      .filter((entry) => entry.visible)
      .map((entry) => entry.mesh);
    const hits = this.raycaster.intersectObjects(pickableMeshes, false);
    const hitId = hits.length > 0 ? hits[0]!.object.name : null;

    if (this.interactionMode === 'measure') {
      // Measurement mode has no "click empty space to deselect" analogue —
      // a miss is simply ignored (see `SceneManagerOptions.onMeasurePick`'s
      // doc). The reported ray is `this.raycaster.ray`'s own origin/direction
      // (already exactly what `setFromCamera` computed for this click, in
      // THIS SceneManager's render frame) — no separate re-derivation needed.
      if (hitId) {
        const { origin, direction } = this.raycaster.ray;
        this.onMeasurePick?.({
          nodeId: hitId,
          rayOrigin: [origin.x, origin.y, origin.z],
          rayDirection: [direction.x, direction.y, direction.z],
        });
      }
      return;
    }
    this.onSelect?.(hitId);
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (isEditableTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    const view = standardViewForDigitKey(event.key);
    if (!view) return;
    event.preventDefault();
    this.setStandardView(view);
  };

  // ---------------------------------------------------------------------
  // Camera: projection toggle
  // ---------------------------------------------------------------------

  getProjection(): CameraProjection {
    return this.projectionMode;
  }

  /** Switches between perspective and orthographic while keeping the
   * shared `OrbitControls.target` and the camera's viewing DIRECTION (and,
   * approximately, its apparent zoom level) — "shared controls state
   * survives toggle" from this task's brief. Reassigning `controls.object`
   * to the other camera is safe: Three's `OrbitControls` (and its `Controls`
   * base class) reference `this.object` directly everywhere rather than
   * closing over the constructor argument, so swapping it before the next
   * `controls.update()`/render is exactly the supported pattern for a
   * perspective/ortho toggle. */
  setProjection(mode: CameraProjection): void {
    if (mode === this.projectionMode) return;
    const oldCamera = this.activeCamera;
    const target = this.controls.target;
    const distance = Math.max(oldCamera.position.distanceTo(target), MIN_FRAME_RADIUS_MM);
    const direction = oldCamera.position.clone().sub(target);
    if (direction.lengthSq() < 1e-9) direction.copy(this.frontDirection());
    direction.normalize();

    this.projectionMode = mode;
    const newCamera = this.activeCamera;
    newCamera.up.copy(oldCamera.up);

    if (mode === 'orthographic') {
      const halfFovRad = MathUtils.degToRad(this.perspectiveCamera.fov) / 2;
      this.orthoHalfHeightMm = Math.max(distance * Math.tan(halfFovRad), MIN_FRAME_RADIUS_MM);
      const orthoDistance = this.orthoHalfHeightMm * ORTHO_CAMERA_DISTANCE_FACTOR;
      newCamera.position.copy(target).addScaledVector(direction, orthoDistance);
      // Same near/far formula `applyFraming`'s ortho branch uses (there,
      // `padded` — here, the just-recomputed `orthoHalfHeightMm` plays the
      // same role) — without this, a toggle-to-ortho that happens before
      // any `frameAll`/`frameSelection`/`setStandardView` call ever ran
      // would leave the orthographic camera at its wide constructor-default
      // near/far (0.1mm/5000mm) instead of one fit to the actual current
      // framing, same "no prior framing edge case" this task's brief calls out.
      newCamera.near = 0.01;
      newCamera.far = orthoDistance + this.orthoHalfHeightMm * 4;
    } else {
      const halfFovRad = MathUtils.degToRad(this.perspectiveCamera.fov) / 2;
      const perspectiveDistance = Math.max(
        this.orthoHalfHeightMm / Math.tan(halfFovRad),
        MIN_FRAME_RADIUS_MM,
      );
      newCamera.position.copy(target).addScaledVector(direction, perspectiveDistance);
      // Mirrors `applyFraming`'s perspective branch, with `orthoHalfHeightMm`
      // (the last-known framed half-extent) standing in for `padded`.
      newCamera.near = Math.max(0.01, perspectiveDistance - this.orthoHalfHeightMm * 4);
      newCamera.far = perspectiveDistance + this.orthoHalfHeightMm * 4;
    }

    this.controls.object = newCamera;
    this.handleResize();
    this.controls.update();
  }

  // ---------------------------------------------------------------------
  // Mouse bindings
  // ---------------------------------------------------------------------

  setViewerBindings(bindings: ViewerBindings): void {
    this.controls.mouseButtons = toOrbitControlsMouseMap(bindings);
  }

  // ---------------------------------------------------------------------
  // Standard views / framing
  // ---------------------------------------------------------------------

  /** Jaw-aware standard view — see engine/standardViews.ts's module doc for
   * the axis convention and the occlusal jaw-flip rule. */
  setStandardView(view: StandardView): void {
    const jawContext = resolveJawContext(this.currentRoles);
    const [x, y, z] = standardViewOffset(view, jawContext);
    const { center, radius } = this.computeBoundingSphere({ visibleOnly: true }) ?? {
      center: new Vector3(0, 0, 0),
      radius: DEFAULT_EMPTY_FRAME_RADIUS_MM,
    };
    this.applyFraming(center, radius, new Vector3(x, y, z));
  }

  /** Frames every currently VISIBLE mesh (hidden nodes don't affect the
   * shot), keeping the camera's current viewing direction. */
  frameAll(): void {
    const sphere = this.computeBoundingSphere({ visibleOnly: true });
    const direction = this.currentViewDirection();
    if (sphere) {
      this.applyFraming(sphere.center, sphere.radius, direction);
    } else {
      this.applyFraming(new Vector3(0, 0, 0), DEFAULT_EMPTY_FRAME_RADIUS_MM, direction);
    }
  }

  /** Frames the current selection only; falls back to `frameAll()` if
   * nothing is selected (or the selected node is no longer live). */
  frameSelection(): void {
    const entry = this.selectedNodeId ? this.meshEntries.get(this.selectedNodeId) : undefined;
    if (!entry || !entry.geometry.boundingSphere) {
      this.frameAll();
      return;
    }
    const { center, radius } = entry.geometry.boundingSphere;
    this.applyFraming(center.clone(), radius, this.currentViewDirection());
  }

  private currentViewDirection(): Vector3 {
    const direction = this.activeCamera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() < 1e-9) return this.frontDirection();
    return direction.normalize();
  }

  private computeBoundingSphere(opts: {
    visibleOnly: boolean;
  }): { center: Vector3; radius: number } | null {
    const box = new Box3();
    let any = false;
    for (const entry of this.meshEntries.values()) {
      if (opts.visibleOnly && !entry.visible) continue;
      if (!entry.geometry.boundingBox) entry.geometry.computeBoundingBox();
      if (entry.geometry.boundingBox) {
        box.union(entry.geometry.boundingBox);
        any = true;
      }
    }
    if (!any) return null;
    const sphere = new Sphere();
    box.getBoundingSphere(sphere);
    return { center: sphere.center, radius: Math.max(sphere.radius, MIN_FRAME_RADIUS_MM) };
  }

  private applyFraming(center: Vector3, radius: number, direction: Vector3): void {
    const padded = Math.max(radius, MIN_FRAME_RADIUS_MM) * FRAME_PADDING;
    this.controls.target.copy(center);

    if (this.projectionMode === 'perspective') {
      const halfFovRad = MathUtils.degToRad(this.perspectiveCamera.fov) / 2;
      const distance = padded / Math.sin(halfFovRad);
      this.perspectiveCamera.position.copy(center).addScaledVector(direction, distance);
      this.perspectiveCamera.near = Math.max(0.01, distance - padded * 4);
      this.perspectiveCamera.far = distance + padded * 4;
      this.perspectiveCamera.updateProjectionMatrix();
    } else {
      this.orthoHalfHeightMm = padded;
      this.applyOrthoFrustum();
      const distance = padded * ORTHO_CAMERA_DISTANCE_FACTOR;
      this.orthographicCamera.position.copy(center).addScaledVector(direction, distance);
      this.orthographicCamera.near = 0.01;
      this.orthographicCamera.far = distance + padded * 4;
      this.orthographicCamera.updateProjectionMatrix();
    }
    this.controls.update();
  }

  private applyOrthoFrustum(): void {
    const aspect = this.currentAspect();
    const halfHeight = this.orthoHalfHeightMm;
    this.orthographicCamera.left = -halfHeight * aspect;
    this.orthographicCamera.right = halfHeight * aspect;
    this.orthographicCamera.top = halfHeight;
    this.orthographicCamera.bottom = -halfHeight;
    this.orthographicCamera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------------
  // Resize / animate / dispose
  // ---------------------------------------------------------------------

  private handleResize(): void {
    const { clientWidth: width, clientHeight: height } = this.container;
    if (width === 0 || height === 0) return;
    this.perspectiveCamera.aspect = width / height;
    this.perspectiveCamera.updateProjectionMatrix();
    this.applyOrthoFrustum();
    this.renderer.setSize(width, height);
  }

  private animate(): void {
    if (this.disposed) return;
    this.animationFrameId = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.activeCamera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('keydown', this.handleKeyDown);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    // Every geometry/material still attached to the scene graph — mesh
    // entries (incl. wireframe overlays) and the grid — see
    // disposeObject3DTree's doc for why this also fixes the Phase 0
    // GridHelper leak. Lights have nothing to dispose, traversal skips them.
    disposeObject3DTree(this.scene);
    this.matcapTexture.dispose();
    this.meshEntries.clear();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
