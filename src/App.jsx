import React, { useRef, useEffect, useState } from 'react';
import Navbar from './components/Navbar';
import FrameCanvas from './components/FrameCanvas';
import Hero from './components/Hero';
import Footer from './components/Footer';

import FrameLoader, { LoaderState } from './animation/FrameLoader';
import ScrollController from './animation/ScrollController';
import { frameRenderer } from './animation/FrameRenderer';

export default function App() {
  const scrollTrackRef = useRef(null);
  const canvasRef = useRef(null);

  const [renderedFrame, setRenderedFrame] = useState(0);
  const [scrollProgress, setScrollProgress] = useState(0);

  useEffect(() => {
    // 1. Initialize Progressive FrameLoader with updated frame sequence
    const loader = new FrameLoader({
      totalFrames: 150,
      framePathPattern: (i) => `/frames/frame-${String(i + 1).padStart(3, '0')}.jpg?v=2`,
      onProgress: () => {
        if (canvasRef.current) {
          frameRenderer.render(canvasRef.current, 0);
        }
      },
      onStatusChange: () => {
        if (canvasRef.current) {
          frameRenderer.render(canvasRef.current, 0);
        }
      },
    });

    loader.start();

    // 2. Initialize ScrollController over the pure cinematic scroll track
    const controller = new ScrollController({
      containerRef: scrollTrackRef.current,
      totalFrames: 150,
      lerpFactor: 0.18,
      onFrameUpdate: (frame, progress) => {
        setRenderedFrame(frame);
        setScrollProgress(progress);
      },
    });

    controller.attach();

    return () => {
      controller.detach();
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#080808] text-white selection:bg-[#2ee6ca] selection:text-black">
      
      {/* PERSISTENT FULLSCREEN CANVA ENGINE (Fixed background, zero flicker) */}
      <div className="fixed inset-0 z-0 pointer-events-none w-screen h-screen overflow-hidden">
        <FrameCanvas ref={canvasRef} currentFrame={renderedFrame} />
      </div>

      {/* Minimal Fixed Luxury Navbar */}
      <Navbar />

      {/* PURE CINEMATIC SCROLL CONTAINER */}
      <main className="relative z-10">
        <div ref={scrollTrackRef} className="relative" style={{ height: '480vh' }}>
          
          {/* ONLY OVERLAY: HERO SECTION (THE FUTURE OF PARKING) */}
          <div className="relative min-h-screen flex flex-col justify-center">
            <Hero onExploreClick={() => {
              window.scrollBy({ top: window.innerHeight * 0.9, behavior: 'smooth' });
            }} />
          </div>

          {/* After Hero: ZERO OVERLAYS TILL LAST FRAME OF CAR.
              The remaining ~320vh is 100% unobstructed, pure cinematic car movement. */}
        </div>

        {/* FOOTER AT LAST FRAME OF CAR */}
        <div className="relative z-20 bg-[#080808] border-t border-white/[0.08]">
          <Footer />
        </div>
      </main>

    </div>
  );
}
