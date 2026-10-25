import React, { forwardRef, useEffect } from 'react';
import { frameRenderer } from '../animation/FrameRenderer';

const FrameCanvas = forwardRef(function FrameCanvas({ currentFrame = 0 }, ref) {
  useEffect(() => {
    const canvas = ref?.current;
    if (!canvas) return;

    const handleResize = () => {
      frameRenderer.resize(canvas);
      frameRenderer.render(canvas, currentFrame);
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [ref]);

  useEffect(() => {
    const canvas = ref?.current;
    if (canvas) {
      frameRenderer.render(canvas, currentFrame);
    }
  }, [currentFrame, ref]);

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#080808]">
      <canvas
        ref={ref}
        className="w-full h-full object-cover block"
        style={{
          width: '100vw',
          height: '100vh',
          backgroundColor: '#080808',
        }}
      />
      
      {/* Luxury Cinematic Vignette & Ambient Darkness Overlays */}
      <div className="absolute inset-0 pointer-events-none bg-gradient-to-t from-[#080808] via-transparent to-[#080808]/70" />
      <div className="absolute inset-0 pointer-events-none bg-gradient-to-r from-[#080808]/40 via-transparent to-[#080808]/40" />
    </div>
  );
});

export default FrameCanvas;
