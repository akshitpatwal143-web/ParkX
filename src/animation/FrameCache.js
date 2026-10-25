/**
 * ParkX FrameCache
 * High-performance in-memory cache for decoded animation frames.
 * Prevents re-fetching, eliminates layout shifts, and ensures zero flickering.
 */

class FrameCache {
  constructor(totalFrames = 150) {
    this.totalFrames = totalFrames;
    this.cache = new Map(); // index -> ImageBitmap | HTMLImageElement
  }

  set(index, bitmapOrImage) {
    this.cache.set(index, bitmapOrImage);
  }

  get(index) {
    return this.cache.get(index);
  }

  has(index) {
    return this.cache.has(index);
  }

  get size() {
    return this.cache.size;
  }

  /**
   * Graceful fallback: If the exact frame is not yet ready,
   * find the nearest available decoded frame to avoid white flashes or blank frames.
   */
  getNearest(targetIndex) {
    if (this.cache.has(targetIndex)) {
      return this.cache.get(targetIndex);
    }

    let nearest = null;
    let minDistance = Infinity;

    for (const [idx, img] of this.cache.entries()) {
      const dist = Math.abs(idx - targetIndex);
      if (dist < minDistance) {
        minDistance = dist;
        nearest = img;
      }
    }

    return nearest;
  }

  clear() {
    this.cache.clear();
  }
}

export const frameCache = new FrameCache(150);
export default FrameCache;
