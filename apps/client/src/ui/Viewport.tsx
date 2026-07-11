// Thin React wrapper around the imperative engine — mounts SceneManager on
// a plain DOM container via useRef+useEffect and disposes it on unmount.
// No Three.js imports here; all render objects live in src/engine/.
import { useEffect, useRef } from 'react';
import { caseStore } from '../engine/caseStore';
import { heatmapEngine } from '../engine/heatmap';
import { toMeasurementRenderData, toWorldRay } from '../engine/measurementFrame';
import type { RenderNode } from '../engine/renderNode';
import { sectionEngine } from '../engine/section';
import { SceneManager, type MeasurePickCandidate } from '../engine/SceneManager';
import { toolManager } from '../engine/ToolManager';
import { registerActiveSceneManager } from '../engine/viewerController';
import { useAppStore } from '../state/appStore';
import { useCaseStore } from '../state/caseStore';
import { useHeatmapStore } from '../state/heatmapStore';
import { useSectionStore } from '../state/sectionStore';
import { useToolStore } from '../state/toolStore';
import { useViewerStore } from '../state/viewerStore';
import { MeasureToolbar } from './MeasureToolbar';
import { MeasurementOverlay } from './MeasurementOverlay';
import { ViewerToolbar } from './ViewerToolbar';

/** `caseStore.getRenderNodes()`'s output, with the active heatmap overlay's
 * colors (if any — see engine/heatmap.ts's `getActiveOverlay`) merged onto
 * its matching source node. Kept HERE (not inside engine/caseStore.ts)
 * specifically to avoid a caseStore.ts <-> heatmap.ts import cycle — see
 * heatmap.ts's module doc for the full reasoning. */
function buildRenderNodes(): RenderNode[] {
  const nodes = caseStore.getRenderNodes();
  const overlay = heatmapEngine.getActiveOverlay();
  if (!overlay) {
    return nodes;
  }
  return nodes.map((node) => (node.id === overlay.nodeId ? { ...node, colors: overlay.colors } : node));
}

/** SceneManager's own `onMeasurePick` reports a ray in ITS render frame
 * (Float32-safe, re-centered — see SceneManager.ts's `MeasurePickCandidate`
 * doc); ToolManager.ts always re-casts against the Float64 WORLD-frame mesh
 * (this task's brief's central correctness requirement), so every pick is
 * converted back to world coordinates here, at the one place that bridges
 * the two (mirroring how `syncRenderNodes`'s render nodes and this same
 * conversion, in the other direction, both live in engine/meshStore.ts's
 * `getWorldOffset()`). */
function handleMeasurePick(pick: MeasurePickCandidate): void {
  const worldOffset = caseStore.getRenderWorldOffset();
  const worldRay = toWorldRay(pick, worldOffset);
  void toolManager.handlePick({ nodeId: pick.nodeId, ...worldRay });
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
  const heatmapVisible = useHeatmapStore((state) => state.visible);
  const heatmapStatus = useHeatmapStore((state) => state.status);
  const heatmapRange = useHeatmapStore((state) => state.range);
  const sectionEnabled = useSectionStore((state) => state.enabled);
  const sectionStatus = useSectionStore((state) => state.status);
  const sectionClipEnabled = useSectionStore((state) => state.clipEnabled);
  const sectionPlane = useSectionStore((state) => state.plane);

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
    // visibility/colors change (`heatmapStatus`/`heatmapRange` both change
    // whenever a run completes or its display range is adjusted — see
    // buildRenderNodes' doc for why the overlay itself isn't part of
    // `document`/`useCaseStore`).
    sceneManagerRef.current?.syncRenderNodes(buildRenderNodes());
  }, [document, heatmapVisible, heatmapStatus, heatmapRange]);

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
    sceneManagerRef.current?.setInteractionMode(activeMeasurementTool ? 'measure' : 'select');
  }, [activeMeasurementTool]);

  return (
    <div className="viewport" ref={containerRef}>
      <ViewerToolbar />
      <MeasureToolbar />
      <MeasurementOverlay />
    </div>
  );
}
