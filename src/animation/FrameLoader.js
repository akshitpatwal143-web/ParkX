/**
 * ParkX FrameLoader
 * Progressive priority-based frame preloading system.
 *
 * States:
 * IDLE -> PRELOADING -> PARTIALLY_READY -> READY
 */

import { frameCache } from './FrameCache';

export const LoaderState = {
  IDLE: 'IDLE',
  PRELOADING: 'PRELOADING',
  PARTIALLY_READY: 'PARTIALLY_READY',
  READY: 'READY',
};

class FrameLoader {
  constructor({
    totalFrames = 150,
    framePathPattern = (i) => `/frames/frame-${String(i + 1).padStart(3, '0')}.jpg`,
    onProgress = null,
    onStatusChange = null,
    cache = frameCache,
  } = {}) {
    this.totalFrames = totalFrames;
    this.getFramePath = framePathPattern;
    this.onProgress = onProgress;
    this.onStatusChange = onStatusChange;
    this.cache = cache;

    this.state = LoaderState.IDLE;
    this.loadedCount = 0;
    this.aborted = false;
  }

  setState(newState) {
    if (this.state !== newState) {
      this.state = newState;
      if (this.onStatusChange) {
        this.onStatusChange(newState);
      }
    }
  }

  /**
   * Loads and decodes a single frame into ImageBitmap or HTMLImageElement.
   */
  async loadFrame(index) {
    if (this.cache.has(index)) {
      return this.cache.get(index);
    }

    const url = this.getFramePath(index);

    try {
      if (typeof window !== 'undefined' && 'createImageBitmap' in window) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);
        this.cache.set(index, bitmap);
        this.notifyProgress();
        return bitmap;
      }
    } catch {
      // Fallback to standard Image loading & decoding
    }

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.src = url;
      img.onload = async () => {
        try {
          if ('decode' in img) {
            await img.decode();
          }
          this.cache.set(index, img);
          this.notifyProgress();
          resolve(img);
        } catch {
          this.cache.set(index, img);
          this.notifyProgress();
          resolve(img);
        }
      };
      img.onerror = (err) => {
        console.warn(`ParkX FrameLoader: failed to load frame ${index}`, err);
        resolve(null);
      };
    });
  }

  notifyProgress() {
    this.loadedCount = this.cache.size;
    const percent = Math.min(100, Math.round((this.loadedCount / this.totalFrames) * 100));
    if (this.onProgress) {
      this.onProgress(this.loadedCount, this.totalFrames, percent);
    }
  }

  /**
   * Start progressive loading sequence:
   * 1. Hero frames (0 - 19) -> Triggers PARTIALLY_READY
   * 2. Keyframes across whole sequence (stride of 2)
   * 3. Fill in all remaining frames -> Triggers READY
   */
  async start() {
    if (this.state !== LoaderState.IDLE) return;
    this.setState(LoaderState.PRELOADING);

    // Phase 1: Load Hero frame 0 immediately
    await this.loadFrame(0);

    // Phase 2: Priority Hero frames (0 to 19)
    const heroFrames = [];
    for (let i = 1; i < Math.min(20, this.totalFrames); i++) {
      heroFrames.push(i);
    }
    await Promise.all(heroFrames.map((i) => this.loadFrame(i)));
    this.setState(LoaderState.PARTIALLY_READY);

    // Phase 3: Scrub coverage (every 2nd frame)
    const strideFrames = [];
    for (let i = 20; i < this.totalFrames; i += 2) {
      if (!this.cache.has(i)) {
        strideFrames.push(i);
      }
    }
    // Concurrency pool of 6
    await this.loadBatch(strideFrames, 6);

    // Phase 4: All remaining frames
    const remaining = [];
    for (let i = 0; i < this.totalFrames; i++) {
      if (!this.cache.has(i)) {
        remaining.push(i);
      }
    }
    await this.loadBatch(remaining, 6);

    this.setState(LoaderState.READY);
  }

  async loadBatch(indices, concurrency = 6) {
    let cursor = 0;
    const executeNext = async () => {
      while (cursor < indices.length) {
        const index = indices[cursor++];
        await this.loadFrame(index);
      }
    };
    const workers = Array.from({ length: Math.min(concurrency, indices.length) }, () => executeNext());
    await Promise.all(workers);
  }
}

export default FrameLoader;
