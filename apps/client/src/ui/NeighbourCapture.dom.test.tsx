// apps/client/src/ui/NeighbourCapture.dom.test.tsx
//
// Phase 9 Task 3 — the neighbour / antagonist capture section: what it shows
// for each capture state, and that "Pick" arms the viewport pick the
// Viewport routes to the engine (state/neighbourCaptureStore).
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import {
  INITIAL_CAPTURE,
  useNeighbourPickStore,
  type CaptureState,
} from '../state/neighbourCaptureStore';
import { NeighbourCapture } from './NeighbourCapture';

const WITH_ARCH: CaptureState = {
  ...INITIAL_CAPTURE,
  archScanAvailable: true,
  neighbourTeeth: { mesial: 21, distal: 12 },
};

afterEach(() => {
  cleanup();
  useNeighbourPickStore.getState().setPending(null);
});

describe('NeighbourCapture', () => {
  it('without an arch scan says there is no neighbour geometry and offers no pick', () => {
    render(<NeighbourCapture workflow="cavity" capture={INITIAL_CAPTURE} disabled={false} />);
    expect(screen.getByTestId('cavity-capture-no-arch')).toBeTruthy();
    expect(screen.queryByTestId('cavity-capture-mesial-pick')).toBeNull();
    expect(screen.queryByTestId('cavity-capture-antagonist')).toBeNull();
  });

  it('names the FDI neighbours, arms a pick for one side, and cancels it', async () => {
    const user = userEvent.setup();
    render(<NeighbourCapture workflow="crown" capture={WITH_ARCH} disabled={false} />);
    expect(screen.getByTestId('crown-capture-mesial').textContent).toContain('21');
    expect(screen.getByTestId('crown-capture-distal').textContent).toContain('12');
    await user.click(screen.getByTestId('crown-capture-distal-pick'));
    expect(useNeighbourPickStore.getState().pending).toEqual({ workflow: 'crown', side: 'distal' });
    expect(screen.getByTestId('crown-capture-distal-hint')).toBeTruthy();
    await user.click(screen.getByTestId('crown-capture-distal-cancel'));
    expect(useNeighbourPickStore.getState().pending).toBeNull();
  });

  it('shows a captured side with its window-border bound in µm', () => {
    render(
      <NeighbourCapture
        workflow="crown"
        capture={{
          ...WITH_ARCH,
          mesial: { capturedTriangleCount: 512, capturedAreaMm2: 16, windowBoundaryBandMm: 0.3536 },
        }}
        disabled={false}
      />,
    );
    expect(screen.getByTestId('crown-capture-mesial-captured').textContent).toContain('354');
  });

  it('the opposite arch is used as antagonist only through the explicit confirm button', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn();
    const { rerender } = render(
      <NeighbourCapture
        workflow="crown"
        capture={{ ...WITH_ARCH, oppositeArchAvailable: true }}
        disabled={false}
        onConfirmOppositeArch={confirm}
      />,
    );
    await user.click(screen.getByTestId('crown-capture-antagonist-confirm'));
    expect(confirm).toHaveBeenCalledTimes(1);
    rerender(
      <NeighbourCapture
        workflow="crown"
        capture={{
          ...WITH_ARCH,
          oppositeArchAvailable: true,
          antagonistSource: 'oppositeArch',
          antagonist: {
            capturedTriangleCount: 900,
            capturedAreaMm2: 30,
            windowBoundaryBandMm: 0.25,
          },
        }}
        disabled={false}
        onConfirmOppositeArch={confirm}
      />,
    );
    expect(screen.queryByTestId('crown-capture-antagonist-confirm')).toBeNull();
    expect(screen.getByTestId('crown-capture-antagonist-captured').textContent).toContain('250');
  });
});
