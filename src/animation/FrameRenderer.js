/**
 * ParkX FrameRenderer
 * High-performance canvas renderer for automotive video frame sequence.
 * 
 * Features:
 * - Persistent canvas, zero DOM thrashing
 * - HiDPI (devicePixelRatio) sharpness
 * - Adaptive cover calculation ensuring the car is always framed
 * - Graceful fallback to nearest decoded frame
 */

import { frameCache } from './FrameCache';

class FrameRenderer {
  constructor() {
    this.lastRenderedIndex = -1;
    this.sourceWidth = 1280;
    this.sourceHeight = 720;
  }

  /**
   * Resizes canvas to match viewport and device pixel ratio.
   */
  resize(canvas) {
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
  }

  /**
   * Renders the requested frameIndex onto the canvas.
   */
  render(canvas, frameIndex) {
    if (!canvas) return null;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return null;

    const img = frameCache.getNearest(frameIndex);
    if (!img) return null;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = canvas.width;
    const ch = canvas.height;

    // Calculate aspect cover dimensions
    const imgWidth = img.width || this.sourceWidth;
    const imgHeight = img.height || this.sourceHeight;
    const imgAspect = imgWidth / imgHeight;
    const canvasAspect = cw / ch;

    let drawW, drawH, drawX, drawY;

    if (canvasAspect > imgAspect) {
      // Screen is wider than image (landscape/ultrawide)
      drawW = cw;
      drawH = cw / imgAspect;
      drawX = 0;
      drawY = (ch - drawH) / 2;
    } else {
      // Screen is taller than image (portrait / mobile)
      drawH = ch;
      drawW = ch * imgAspect;
      const scale = drawH / imgHeight;

      // Intelligent Focal Tracking:
      // Keep car centered on mobile screens so it is never cropped
      let focalX = 410;
      if (frameIndex > 100) {
        focalX = 600;
      } else if (frameIndex > 60) {
        const t = (frameIndex - 60) / 40;
        focalX = 410 + t * (600 - 410);
      }

      // Center the car's focal point horizontally
      const targetDrawX = (cw / 2) - (focalX * scale);
      drawX = Math.min(0, Math.max(cw - drawW, targetDrawX));
      drawY = (ch - drawH) / 2;
    }

    // Direct draw
    ctx.drawImage(img, 0, 0, imgWidth, imgHeight, drawX, drawY, drawW, drawH);

    // Subtle dark luxury vignette overlay to match page background
    const gradient = ctx.createRadialGradient(
      cw / 2, ch / 2, Math.min(cw, ch) * 0.45,
      cw / 2, ch / 2, Math.max(cw, ch) * 0.75
    );
    gradient.addColorStop(0, 'rgba(8, 8, 8, 0)');
    gradient.addColorStop(1, 'rgba(8, 8, 8, 0.4)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, cw, ch);

    this.lastRenderedIndex = frameIndex;
    return frameIndex;
  }
}

export const frameRenderer = new FrameRenderer();
export default FrameRenderer;
