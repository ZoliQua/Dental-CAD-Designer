// Reactive viewer settings (projection mode, shading preset, wireframe
// overlay) that both the toolbar and the engine need to agree on. Same
// DIRECTION as state/appStore.ts's `theme`: ui/ViewerToolbar.tsx writes the
// desired setting here directly (it's the "control panel"), and
// ui/Viewport.tsx's effects apply each change to SceneManager imperatively
// — SceneManager itself never imports zustand (see
// engine/viewerController.ts's module doc), it just exposes plain setter
// methods Viewport calls. One-shot actions (view buttons, frame all/
// selection) are NOT modeled here — see viewerController.ts.
import { create } from 'zustand';

export type CameraProjection = 'perspective' | 'orthographic';
export type ShadingPreset = 'matcap' | 'clinical';

interface ViewerState {
  projection: CameraProjection;
  shadingPreset: ShadingPreset;
  wireframeEnabled: boolean;
  setProjection: (projection: CameraProjection) => void;
  setShadingPreset: (shadingPreset: ShadingPreset) => void;
  setWireframeEnabled: (wireframeEnabled: boolean) => void;
}

export const DEFAULT_PROJECTION: CameraProjection = 'perspective';
export const DEFAULT_SHADING_PRESET: ShadingPreset = 'clinical';

export const useViewerStore = create<ViewerState>((set) => ({
  projection: DEFAULT_PROJECTION,
  shadingPreset: DEFAULT_SHADING_PRESET,
  wireframeEnabled: false,
  setProjection: (projection) => set({ projection }),
  setShadingPreset: (shadingPreset) => set({ shadingPreset }),
  setWireframeEnabled: (wireframeEnabled) => set({ wireframeEnabled }),
}));
