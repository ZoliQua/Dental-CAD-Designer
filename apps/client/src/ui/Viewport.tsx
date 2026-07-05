// Thin React wrapper around the imperative engine — mounts SceneManager on
// a plain DOM container via useRef+useEffect and disposes it on unmount.
// No Three.js imports here; all render objects live in src/engine/.
import { useEffect, useRef } from 'react';
import { caseStore } from '../engine/caseStore';
import { SceneManager } from '../engine/SceneManager';
import { useAppStore } from '../state/appStore';
import { useCaseStore } from '../state/caseStore';

export function Viewport() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneManagerRef = useRef<SceneManager | null>(null);
  const setEngineReady = useAppStore((state) => state.setEngineReady);
  // Subscribing to `document` (rather than deriving render nodes inline in
  // the render body) is what triggers the sync effect below whenever
  // engine/caseStore.ts publishes a new snapshot — e.g. after an import
  // registers a mesh, or a scene node's role/visibility/opacity changes.
  const document = useCaseStore((state) => state.document);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const sceneManager = new SceneManager(container);
    sceneManagerRef.current = sceneManager;
    setEngineReady(true);

    return () => {
      setEngineReady(false);
      sceneManagerRef.current = null;
      sceneManager.dispose();
    };
  }, [setEngineReady]);

  // Minimal "mesh visible in scene" wiring (Task 5 scope — see
  // SceneManager.ts's module doc): re-derive render nodes from the engine's
  // authoritative mesh registry every time the published case document
  // changes, and hand them to SceneManager. Task 6 owns proper
  // camera-framing/incremental updates.
  useEffect(() => {
    sceneManagerRef.current?.setRenderNodes(caseStore.getRenderNodes());
  }, [document]);

  return <div className="viewport" ref={containerRef} />;
}
