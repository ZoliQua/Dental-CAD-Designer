// Thin React wrapper around the imperative engine — mounts SceneManager on
// a plain DOM container via useRef+useEffect and disposes it on unmount.
// No Three.js imports here; all render objects live in src/engine/.
import { useEffect, useRef } from 'react';
import { SceneManager } from '../engine/SceneManager';
import { useAppStore } from '../state/appStore';

export function Viewport() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const setEngineReady = useAppStore((state) => state.setEngineReady);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const sceneManager = new SceneManager(container);
    setEngineReady(true);

    return () => {
      setEngineReady(false);
      sceneManager.dispose();
    };
  }, [setEngineReady]);

  return <div className="viewport" ref={containerRef} />;
}
