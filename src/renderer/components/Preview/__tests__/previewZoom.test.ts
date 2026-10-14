import { describe, expect, it } from 'vitest';
import { clampZoom, fitImageZoom, parseZoomInput, scrollForZoomAt, stepZoom } from '../previewZoom';

describe('preview zoom (#2150)', () => {
  it('fits an image into the viewport but never blows it up past 100%', () => {
    expect(fitImageZoom(2000, 1000, 1000, 1000)).toBe(0.5);
    expect(fitImageZoom(32, 32, 1000, 800)).toBe(1);
  });

  it('keeps the point under the cursor still when zooming', () => {
    // Content x at the cursor: (100 + 50) / 1 = 150 → at 2x it sits at 300, minus the cursor.
    expect(scrollForZoomAt(100, 50, 1, 2)).toBe(250);
    expect(scrollForZoomAt(0, 10, 1, 0.5)).toBe(0);
  });

  it('steps and clamps', () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1.25, -1)).toBe(1);
    expect(clampZoom(100)).toBe(20);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it('reads what someone types into the zoom field', () => {
    expect(parseZoomInput('150')).toBe(1.5);
    expect(parseZoomInput(' 80 % ')).toBe(0.8);
    expect(parseZoomInput('abc')).toBeNull();
    expect(parseZoomInput('0')).toBeNull();
  });
});
