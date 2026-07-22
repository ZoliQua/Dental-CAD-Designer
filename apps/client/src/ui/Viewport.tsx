// Thin React wrapper around the imperative engine — mounts SceneManager on
// a plain DOM container via useRef+useEffect and disposes it on unmount.
// No Three.js imports here; all render objects live in src/engine/.
import { useEffect, useRef } from 'react';
import { alignmentEngine } from '../engine/alignment';
import { axisEngine } from '../engine/axis';
import { caseStore } from '../engine/caseStore';
import { curvatureEngine } from '../engine/curvature';
import { heatmapEngine } from '../engine/heatmap';
import { lodEngine } from '../engine/lod';
import { marginEditor } from '../engine/marginEditor';
import { toMarginOverlayRenderData } from '../engine/marginFrame';
import { toMeasurementRenderData, toWorldRay } from '../engine/measurementFrame';
import type { RenderNode } from '../engine/renderNode';
import { sectionEngine } from '../engine/section';
import { SceneManager, type AxisOverlayRenderData, type MeasurePickCandidate } from '../engine/SceneManager';
import { toolManager } from '../engine/ToolManager';
import { registerActiveSceneManager } from '../engine/viewerController';
import { useAlignmentStore } from '../state/alignmentStore';
import { useAppStore } from '../state/appStore';
import { useAxisStore } from '../state/axisStore';
import { useCaseStore } from '../state/caseStore';
import { useCurvatureStore } from '../state/curvatureStore';
import { useHeatmapStore } from '../state/heatmapStore';
import { useLodStore } from '../state/lodStore';
import { useMarginStore } from '../state/marginStore';
import { useSectionStore } from '../state/sectionStore';
import { useToolStore } from '../state/toolStore';
import { useViewerStore } from '../state/viewerStore';
import { MarginOverlay } from './MarginOverlay';
import { MeasureToolbar } from './MeasureToolbar';
import { MeasurementOverlay } from './MeasurementOverlay';
import { ViewerToolbar } from './ViewerToolbar';

/** `caseStore.getRenderNodes()`'s output, with the active heatmap AND/OR
 * curvature AND/OR axis-undercut-heatmap overlay's colors (if any — see
 * engine/heatmap.ts's / engine/curvature.ts's / engine/axis.ts's
 * `getActiveOverlay`/`getHeatmapOverlay`) merged onto their matching source
 * node(s). Kept HERE (not inside engine/caseStore.ts) specifically to avoid
 * a caseStore.ts <-> heatmap.ts/curvature.ts/axis.ts import cycle — see
 * heatmap.ts's module doc for the full reasoning (curvature.ts's/axis.ts's
 * overlays mirror it identically). If more than one overlay happens to
 * target the SAME node, axis wins over curvature wins over heatmap
 * (arbitrary but documented tie-break — a dev user driving multiple panels
 * on one mesh at once is not an expected workflow; axis wins because it's
 * the most likely to be the tool actively being interacted with while its
 * panel is open — the live undercut heatmap only exists to be watched
 * during a manual axis adjustment). */
function buildRenderNodes(): RenderNode[] {
  const nodes = caseStore.getRenderNodes();
  const heatmapOverlay = heatmapEngine.getActiveOverlay();
  const curvatureOverlay = curvatureEngine.getActiveOverlay();
  const axisHeatmapOverlay = axisEngine.getHeatmapOverlay();
  if (!heatmapOverlay && !curvatureOverlay && !axisHeatmapOverlay) {
    return nodes;
  }
  return nodes.map((node) => {
    // Overlay colors are per-vertex buffers computed against the FULL-RES
    // mesh (heatmap/curvature/axis all query the Float64 master) — a node
    // currently rendering via its LOD copy (Phase 2 Task 10) has a
    // different vertex count, so the overlay is skipped for it rather than
    // fed to SceneManager mis-sized (RenderNode.colors' doc: producers are
    // responsible for supplying a buffer sized to match `positions`).
    // Toggling LOD off (dev panel) restores the overlay unchanged.
    if (axisHeatmapOverlay && node.id === axisHeatmapOverlay.nodeId && axisHeatmapOverlay.colors.length === node.positions.length) {
      return { ...node, colors: axisHeatmapOverlay.colors };
    }
    if (curvatureOverlay && node.id === curvatureOverlay.nodeId && curvatureOverlay.colors.length === node.positions.length) {
      return { ...node, colors: curvatureOverlay.colors };
    }
    if (heatmapOverlay && node.id === heatmapOverlay.nodeId && heatmapOverlay.colors.length === node.positions.length) {
      return { ...node, colors: heatmapOverlay.colors };
    }
    return node;
  });
}

/** Purely cosmetic arrow length (mm) for the insertion-axis gizmo — not a
 * measured quantity, see engine/SceneManager.ts's `AxisOverlayRenderData`
 * doc. Sized to read clearly on a typical crown/bridge-scale restoration
 * without this file needing to know the restoration's actual geometric
 * scale. */
const AXIS_ARROW_LENGTH_MM = 10;

/** Builds the insertion-axis arrow gizmo's render data from the CURRENT
 * axis-tool session (`useAxisStore`) — `null` when the tool isn't active.
 * The arrow's ORIGIN is the average position of the FIRST abutment's
 * confirmed margin-line anchors (a reasonable, always-available anchor
 * point near the restoration; a bridge's common axis is still shown from
 * just one abutment's location — precise per-abutment placement isn't the
 * point of a single shared-axis gizmo). Read fresh at sync time (not
 * memoized) — same "read fresh inside the effect" pattern as
 * `buildRenderNodes`'s heatmap overlay. */
function buildAxisOverlay(): AxisOverlayRenderData | null {
  const store = useAxisStore.getState();
  if (store.status === 'idle' || !store.restorationId || store.abutmentTeeth.length === 0) return null;
  const restoration = caseStore.getDocument().restorations.find((r) => r.id === store.restorationId);
  if (!restoration) return null;
  const marginLine = restoration.marginLines[store.abutmentTeeth[0]!];
  if (!marginLine || marginLine.anchors.length === 0) return null;

  const worldOffset = caseStore.getRenderWorldOffset();
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const anchor of marginLine.anchors) {
    sx += anchor.position[0];
    sy += anchor.position[1];
    sz += anchor.position[2];
  }
  const n = marginLine.anchors.length;
  const origin: readonly [number, number, number] = [
    sx / n - worldOffset[0],
    sy / n - worldOffset[1],
    sz / n - worldOffset[2],
  ];
  return { origin, direction: store.direction, lengthMm: AXIS_ARROW_LENGTH_MM };
}

/** SceneManager's own `onMeasurePick` reports a ray in ITS render frame
 * (Float32-safe, re-centered — see SceneManager.ts's `MeasurePickCandidate`
 * doc); ToolManager.ts/alignmentEngine both always re-cast against the
 * Float64 WORLD-frame mesh (the measurement tool's brief's central
 * correctness requirement, reused verbatim by the alignment tool's own
 * picking — see engine/alignment.ts's `handlePick` doc), so every pick is
 * converted back to world coordinates here, at the one place that bridges
 * the two (mirroring how `syncRenderNodes`'s render nodes and this same
 * conversion, in the other direction, both live in engine/meshStore.ts's
 * `getWorldOffset()`).
 *
 * Routes to EITHER `toolManager.handlePick` (a measurement tool active) OR
 * `alignmentEngine.handlePick` (alignment is mid-picking) — never both.
 * SceneManager itself has no notion of "which tool"; it just reports
 * 'measure'-mode clicks the same way regardless (see `setInteractionMode`'s
 * call site below), and this function is the one place that decides who
 * consumes them, same "engine decides, SceneManager stays generic" split as
 * every other interaction-mode consumer in this file. */
function handleMeasurePick(pick: MeasurePickCandidate): void {
  const worldOffset = caseStore.getRenderWorldOffset();
  const worldRay = toWorldRay(pick, worldOffset);
  const request = { candidateNodeIds: pick.candidateNodeIds, ...worldRay };
  if (useAlignmentStore.getState().phase === 'pickingPairs') {
    void alignmentEngine.handlePick(request);
    return;
  }
  // Margin editing (Phase 3 Task 5) always targets exactly ONE mesh (the
  // restoration's assigned target scan) — `marginEditor.handlePick` ignores
  // `candidateNodeIds` entirely and raycasts only its own target, so the
  // (multi-candidate) `request` shape is reused verbatim, same "SceneManager
  // stays generic, engine decides" split as alignment vs. measurement above.
  if (useMarginStore.getState().phase === 'active') {
    void marginEditor.handlePick(worldRay);
    return;
  }
  void toolManager.handlePick(request);
}

export function Viewport() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneManagerRef = useRef<SceneManager | null>(null);
  const setEngineReady = useAppStore((state) => state.setEngineReady);
  const theme = useAppStore((state) => state.theme);
  // Subscribing to `document` (rather than deriving render nodes inline in
  // the render body) is what triggers the sync effect below whenever
  // engine/caseStore.ts publishes a new snapshot — e.g. after an import
  // registers a mesh, or a scene node's role/visibility/opacity changes.
  const document = useCaseStore((state) => state.document);
  const selectedNodeId = useCaseStore((state) => state.selectedNodeId);
  const projection = useViewerStore((state) => state.projection);
  const shadingPreset = useViewerStore((state) => state.shadingPreset);
  const wireframeEnabled = useViewerStore((state) => state.wireframeEnabled);
  const activeMeasurementTool = useToolStore((state) => state.activeTool);
  const alignmentPhase = useAlignmentStore((state) => state.phase);
  const marginPhase = useMarginStore((state) => state.phase);
  const marginSegments = useMarginStore((state) => state.segments);
  const marginSegmentConfidence = useMarginStore((state) => state.segmentConfidence);
  const marginHumanEdited = useMarginStore((state) => state.humanEdited);
  const heatmapVisible = useHeatmapStore((state) => state.visible);
  const heatmapStatus = useHeatmapStore((state) => state.status);
  const heatmapRange = useHeatmapStore((state) => state.range);
  const curvatureVisible = useCurvatureStore((state) => state.visible);
  const curvatureStatus = useCurvatureStore((state) => state.status);
  const curvatureRange = useCurvatureStore((state) => state.range);
  const lodMode = useLodStore((state) => state.mode);
  const lodBuildStatus = useLodStore((state) => state.buildStatus);
  const sectionEnabled = useSectionStore((state) => state.enabled);
  const sectionStatus = useSectionStore((state) => state.status);
  const sectionClipEnabled = useSectionStore((state) => state.clipEnabled);
  const sectionPlane = useSectionStore((state) => state.plane);
  const axisStatus = useAxisStore((state) => state.status);
  const axisDirection = useAxisStore((state) => state.direction);
  const axisHeatmapVisible = useAxisStore((state) => state.heatmapVisible);
  const axisHeatmapGeneration = useAxisStore((state) => state.heatmapGeneration);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    // Read the CURRENT store values at mount time only — SceneManager takes
    // them as one-shot constructor defaults; every later change is applied
    // imperatively by the effects below (same "engine applies what ui
    // asked for" round trip as the render-node/theme/selection sync).
    const sceneManager = new SceneManager(container, {
      onSelect: (nodeId) => caseStore.setSelectedNodeId(nodeId),
      onMeasurePick: handleMeasurePick,
      initialTheme: useAppStore.getState().theme,
      initialProjection: useViewerStore.getState().projection,
      initialShadingPreset: useViewerStore.getState().shadingPreset,
      initialWireframeEnabled: useViewerStore.getState().wireframeEnabled,
    });
    sceneManagerRef.current = sceneManager;
    registerActiveSceneManager(sceneManager);
    setEngineReady(true);

    return () => {
      setEngineReady(false);
      registerActiveSceneManager(null);
      sceneManagerRef.current = null;
      sceneManager.dispose();
    };
  }, [setEngineReady]);

  useEffect(() => {
    // Re-syncs whenever the case document changes OR the active heatmap's
    // OR curvature overlay's visibility/colors change (`heatmapStatus`/
    // `heatmapRange`/`curvatureStatus`/`curvatureRange` all change whenever
    // a run completes or its display range is adjusted — see
    // buildRenderNodes' doc for why the overlay itself isn't part of
    // `document`/`useCaseStore`).
    // `lodMode`/`lodBuildStatus` are deps too (Phase 2 Task 10):
    // caseStore.getRenderNodes() picks between the full-res and LOD render
    // copies based on the current mode + whether a build has completed —
    // see engine/caseStore.ts's LOD-selection doc.
    sceneManagerRef.current?.syncRenderNodes(buildRenderNodes());
  }, [
    document,
    heatmapVisible,
    heatmapStatus,
    heatmapRange,
    curvatureVisible,
    curvatureStatus,
    curvatureRange,
    lodMode,
    lodBuildStatus,
    axisHeatmapVisible,
    axisHeatmapGeneration,
  ]);

  useEffect(() => {
    // Kicks off LOD builds for any mesh the current mode wants one for
    // (idempotent — see lodEngine.syncLodBuilds' doc). Runs on the same
    // triggers that can change the answer: a new mesh registered
    // (`document`) or the dev toggle switched (`lodMode`).
    lodEngine.syncLodBuilds();
  }, [document, lodMode]);

  useEffect(() => {
    // Same trigger as the render-node sync above: a measurement's points
    // are stored in world coordinates (caseStore.getRenderWorldOffset()'s
    // frame), and the world offset itself only ever changes alongside a
    // `document` publish (meshStore's recenterAll runs inside
    // register/remove, which always publish immediately after — see
    // meshStore.ts's module doc) — so re-deriving render-frame points off
    // `document` here can never observe a stale offset.
    const worldOffset = caseStore.getRenderWorldOffset();
    sceneManagerRef.current?.syncMeasurements(
      toMeasurementRenderData(document.measurements, worldOffset),
    );
  }, [document]);

  useEffect(() => {
    // Re-syncs the cross-section outline/cap overlay AND the clip plane
    // whenever the section tool's result/toggles change OR the document
    // changes (a mesh add/remove/visibility change can shift the scene
    // bbox center the plane's axis presets/offset are measured from, and
    // engine/section.ts's own recompute() already re-derives the plane from
    // scratch on every relevant change — this effect just re-reads
    // whatever it last computed). `sectionEngine.getOutline()`/`getCaps()`/
    // `getClipPlane()` return the CURRENT (possibly still-stale-during-a-
    // run, but never wrong) private buffers — same "read fresh inside the
    // effect" pattern as `buildRenderNodes`'s heatmap overlay above.
    sceneManagerRef.current?.syncSectionOverlay(sectionEngine.getOutline(), sectionEngine.getCaps());
    sceneManagerRef.current?.setSectionClipPlane(sectionEngine.getClipPlane());
  }, [document, sectionEnabled, sectionStatus, sectionClipEnabled, sectionPlane]);

  useEffect(() => {
    // Insertion-axis arrow gizmo (Phase 3 Task 9) — re-syncs whenever the
    // axis tool session starts/stops, the current direction changes
    // (suggestion or manual slider), or the document changes (a margin
    // line could have shifted the anchor-centroid origin, or the world
    // offset itself could have moved).
    sceneManagerRef.current?.syncAxisOverlay(buildAxisOverlay());
  }, [document, axisStatus, axisDirection]);

  useEffect(() => {
    sceneManagerRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    sceneManagerRef.current?.setSelectedNodeId(selectedNodeId);
  }, [selectedNodeId]);

  useEffect(() => {
    sceneManagerRef.current?.setProjection(projection);
  }, [projection]);

  useEffect(() => {
    sceneManagerRef.current?.setShadingPreset(shadingPreset);
  }, [shadingPreset]);

  useEffect(() => {
    sceneManagerRef.current?.setWireframeEnabled(wireframeEnabled);
  }, [wireframeEnabled]);

  useEffect(() => {
    // Alignment/margin picking both reuse the SAME 'measure' interaction
    // mode as the measurement tools (candidate-set + ray reporting) — see
    // `handleMeasurePick`'s doc for how the three are told apart.
    const measureModeActive = Boolean(activeMeasurementTool) || alignmentPhase === 'pickingPairs' || marginPhase === 'active';
    sceneManagerRef.current?.setInteractionMode(measureModeActive ? 'measure' : 'select');
  }, [activeMeasurementTool, alignmentPhase, marginPhase]);

  useEffect(() => {
    // Margin curve overlay (Phase 3 Task 5) — re-syncs whenever the live
    // margin store's segments/confidence/origin change, or the world offset
    // could have shifted (`document`), same trigger set as the measurement
    // overlay sync above.
    const worldOffset = caseStore.getRenderWorldOffset();
    sceneManagerRef.current?.syncMarginOverlay(
      toMarginOverlayRenderData(marginSegments, marginSegmentConfidence, marginHumanEdited, worldOffset),
    );
  }, [document, marginSegments, marginSegmentConfidence, marginHumanEdited]);

  return (
    <div className="viewport" ref={containerRef}>
      <ViewerToolbar />
      <MeasureToolbar />
      <MeasurementOverlay />
      <MarginOverlay />
    </div>
  );
}
