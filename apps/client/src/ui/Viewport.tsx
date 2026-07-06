// Thin React wrapper around the imperative engine — mounts SceneManager on
// a plain DOM container via useRef+useEffect and disposes it on unmount.
// No Three.js imports here; all render objects live in src/engine/.
import { useEffect, useRef } from 'react';
import { caseStore } from '../engine/caseStore';
import { SceneManager } from '../engine/SceneManager';
import { registerActiveSceneManager } from '../engine/viewerController';
import { useAppStore } from '../state/appStore';
import { useCaseStore } from '../state/caseStore';
import { useViewerStore } from '../state/viewerStore';
import { ViewerToolbar } from './ViewerToolbar';

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
    sceneManagerRef.current?.syncRenderNodes(caseStore.getRenderNodes());
  }, [document]);

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

  return (
    <div className="viewport" ref={containerRef}>
      <ViewerToolbar />
    </div>
  );
}
