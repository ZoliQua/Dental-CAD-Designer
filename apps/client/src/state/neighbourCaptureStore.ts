// apps/client/src/state/neighbourCaptureStore.ts
//
// Phase 9 Task 3 (ADR-022) — the UI-facing shapes of neighbour / antagonist
// capture from the case's scans, shared by the crown and cavity stores, plus
// the one piece of cross-workflow UI state: which side is waiting for a
// viewport pick (ui/Viewport.tsx routes the next click on the arch scan to
// the workflow that asked for it).
import { create } from 'zustand';

/** One capture from a case scan (Phase 9 Task 3) — the panel readout. */
export interface CaptureSummary {
  capturedTriangleCount: number;
  capturedAreaMm2: number;
  /** The capture's `@errorBound` on missed contact surface (mm). */
  windowBoundaryBandMm: number;
}

/** Neighbour / antagonist capture state (Phase 9 Task 3, ADR-022). */
export interface CaptureState {
  /** The case has a scan of the restoration's jaw to capture neighbours from. */
  archScanAvailable: boolean;
  /** The case has an opposite-arch scan to offer as the antagonist. */
  oppositeArchAvailable: boolean;
  /** The FDI neighbours (mesial toward the midline). */
  neighbourTeeth: { mesial: number | null; distal: number | null };
  mesial: CaptureSummary | null;
  distal: CaptureSummary | null;
  antagonist: CaptureSummary | null;
  /** Where the antagonist comes from: the case's antagonist-role scan, the
   * user-confirmed opposite arch, or none. */
  antagonistSource: 'antagonistScan' | 'oppositeArch' | null;
  /** The capture in flight, or null. */
  busy: 'mesial' | 'distal' | 'antagonist' | null;
}

export const INITIAL_CAPTURE: CaptureState = {
  archScanAvailable: false,
  oppositeArchAvailable: false,
  neighbourTeeth: { mesial: null, distal: null },
  mesial: null,
  distal: null,
  antagonist: null,
  antagonistSource: null,
  busy: null,
};

/** A capture waiting for its viewport pick. */
export interface PendingNeighbourPick {
  workflow: 'crown' | 'cavity';
  side: 'mesial' | 'distal';
}

export interface NeighbourPickState {
  pending: PendingNeighbourPick | null;
  setPending: (pending: PendingNeighbourPick | null) => void;
}

export const useNeighbourPickStore = create<NeighbourPickState>((set) => ({
  pending: null,
  setPending: (pending) => set({ pending }),
}));
