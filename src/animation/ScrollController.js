/**
 * ParkX ScrollController
 * Maps scroll position of the sticky cinematic section to target animation frames.
 * Uses lerp smoothing via requestAnimationFrame to ensure zero visual jumping.
 */

class ScrollController {
  constructor({
    containerRef,
    totalFrames = 150,
    lerpFactor = 0.14,
    onFrameUpdate = null,
  }) {
    this.container = containerRef;
    this.totalFrames = totalFrames;
    this.lerpFactor = lerpFactor;
    this.onFrameUpdate = onFrameUpdate;

    this.currentFrame = 0;
    this.targetFrame = 0;
    this.progress = 0;
    this.targetProgress = 0;

    this.rafId = null;
    this.isRunning = false;
    this.isReducedMotion = false;

    this.handleScroll = this.handleScroll.bind(this);
    this.loop = this.loop.bind(this);

    this.checkReducedMotion();
  }

  checkReducedMotion() {
    if (typeof window !== 'undefined' && window.matchMedia) {
      this.isReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
  }

  attach() {
    if (typeof window === 'undefined') return;
    window.addEventListener('scroll', this.handleScroll, { passive: true });
    window.addEventListener('resize', this.handleScroll, { passive: true });
    this.handleScroll();
    this.startLoop();
  }

  detach() {
    if (typeof window === 'undefined') return;
    window.removeEventListener('scroll', this.handleScroll);
    window.removeEventListener('resize', this.handleScroll);
    this.stopLoop();
  }

  handleScroll() {
    if (!this.container) return;
    const rect = this.container.getBoundingClientRect();
    const windowHeight = window.innerHeight;
    const totalScrollableDistance = rect.height - windowHeight;

    if (totalScrollableDistance <= 0) {
      this.targetProgress = 0;
      this.targetFrame = 0;
      return;
    }

    // Container's top relative to viewport
    // When top is 0, progress = 0.
    // When bottom reaches window bottom (top = -totalScrollableDistance), progress = 1.
    const scrolled = -rect.top;
    const rawProgress = Math.max(0, Math.min(1, scrolled / totalScrollableDistance));

    this.targetProgress = rawProgress;
    this.targetFrame = rawProgress * (this.totalFrames - 1);

    if (this.isReducedMotion) {
      this.currentFrame = this.targetFrame;
      this.progress = this.targetProgress;
      if (this.onFrameUpdate) {
        this.onFrameUpdate(Math.round(this.currentFrame), this.progress, this.currentFrame, this.targetFrame);
      }
    }
  }

  startLoop() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.loop();
  }

  stopLoop() {
    this.isRunning = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  loop() {
    if (!this.isRunning) return;

    if (!this.isReducedMotion) {
      const diff = this.targetFrame - this.currentFrame;
      
      if (Math.abs(diff) > 0.005) {
        this.currentFrame += diff * this.lerpFactor;
      } else {
        this.currentFrame = this.targetFrame;
      }

      this.progress += (this.targetProgress - this.progress) * this.lerpFactor;

      const roundedFrame = Math.round(this.currentFrame);
      if (this.onFrameUpdate) {
        this.onFrameUpdate(roundedFrame, this.progress, this.currentFrame, this.targetFrame);
      }
    }

    this.rafId = requestAnimationFrame(this.loop);
  }
}

export default ScrollController;
