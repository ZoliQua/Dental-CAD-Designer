// Screen-space HTML overlay for measurement value labels — per this task's
// brief: "screen-space label overlays (HTML overlay layer — no geometry
// text)". SceneManager only ever draws LINES/POINTS for a measurement (see
// SceneManager.ts's `syncMeasurements` doc); the numeric text itself is
// plain DOM, absolutely positioned every animation frame via
// `SceneManager.projectToScreen` — this is what lets it stay perfectly
// legible (a real font, not a billboard texture) while still tracking the
// 3D anchor point as the camera orbits.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { caseStore } from '../engine/caseStore';
import { toMeasurementRenderData } from '../engine/measurementFrame';
import { formatMeasurementValueText } from '../engine/measurementValueText';
import { getActiveSceneManager } from '../engine/viewerController';
import { useCaseStore } from '../state/caseStore';

interface LabelPosition {
  id: string;
  xPx: number;
  yPx: number;
  text: string;
}

type RenderPoint = readonly [number, number, number];

function midpoint(a: RenderPoint, b: RenderPoint): RenderPoint {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

export function MeasurementOverlay() {
  const { t } = useTranslation();
  const document = useCaseStore((state) => state.document);
  const [labels, setLabels] = useState<readonly LabelPosition[]>([]);

  useEffect(() => {
    let frameId: number;

    function tick(): void {
      const sceneManager = getActiveSceneManager();
      if (!sceneManager || document.measurements.length === 0) {
        setLabels((previous) => (previous.length === 0 ? previous : []));
        frameId = requestAnimationFrame(tick);
        return;
      }

      const worldOffset = caseStore.getRenderWorldOffset();
      const rendered = toMeasurementRenderData(document.measurements, worldOffset);
      const next: LabelPosition[] = [];
      for (const measurement of document.measurements) {
        const points = rendered.find((entry) => entry.id === measurement.id)?.points;
        if (!points) continue;
        // Angle's label anchors at the vertex (points[1]); point-to-point/
        // point-to-surface anchor at the segment's midpoint.
        const anchor = measurement.kind === 'angle' ? points[1] : midpoint(points[0]!, points[1]!);
        if (!anchor) continue;
        const projected = sceneManager.projectToScreen(anchor);
        if (!projected) continue;
        const text = formatMeasurementValueText(measurement, (degreesValue) =>
          t('measure.angleValue', { degrees: degreesValue.toFixed(1) }),
        );
        next.push({ id: measurement.id, xPx: projected.xPx, yPx: projected.yPx, text });
      }
      setLabels(next);
      frameId = requestAnimationFrame(tick);
    }

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [document, t]);

  if (labels.length === 0) {
    return null;
  }

  return (
    <div className="measurement-overlay" data-testid="measurement-overlay">
      {labels.map((label) => (
        <div
          key={label.id}
          className="measurement-overlay__label"
          style={{ left: `${label.xPx}px`, top: `${label.yPx}px` }}
          data-testid="measurement-label"
        >
          {label.text}
        </div>
      ))}
    </div>
  );
}
