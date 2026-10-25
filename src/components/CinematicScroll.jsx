import React, { useRef, useEffect, useState } from 'react';
import FrameCanvas from './FrameCanvas';
import Hero from './Hero';
import FrameLoader, { LoaderState } from '../animation/FrameLoader';
import ScrollController from '../animation/ScrollController';
import { frameRenderer } from '../animation/FrameRenderer';
import { ArrowDown, Cpu, Navigation, Gauge, ShieldCheck } from 'lucide-react';

export default function CinematicScroll() {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);

  const [renderedFrame, setRenderedFrame] = useState(0);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [loaderStatus, setLoaderStatus] = useState(LoaderState.IDLE);
  const [loadedPercent, setLoadedPercent] = useState(0);

  useEffect(() => {
    // Initialize FrameLoader
    const loader = new FrameLoader({
      totalFrames: 150,
      framePathPattern: (i) => `/frames/frame-${String(i + 1).padStart(3, '0')}.jpg`,
      onProgress: (loaded, total, percent) => {
        setLoadedPercent(percent);
        if (canvasRef.current) {
          frameRenderer.render(canvasRef.current, 0);
        }
      },
      onStatusChange: (status) => {
        setLoaderStatus(status);
        if (canvasRef.current) {
          frameRenderer.render(canvasRef.current, 0);
        }
      },
    });

    loader.start();

    // Initialize ScrollController
    const controller = new ScrollController({
      containerRef: containerRef.current,
      totalFrames: 150,
      lerpFactor: 0.12,
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

  // Compute opacity for milestone statements based on scrollProgress (0 to 1)
  const calcOpacity = (start, peakStart, peakEnd, end) => {
    if (scrollProgress < start || scrollProgress > end) return 0;
    if (scrollProgress < peakStart) {
      return (scrollProgress - start) / (peakStart - start);
    }
    if (scrollProgress > peakEnd) {
      return 1 - (scrollProgress - peakEnd) / (end - peakEnd);
    }
    return 1;
  };

  const heroOpacity = calcOpacity(0, 0, 0.05, 0.16);
  const scene1Opacity = calcOpacity(0.18, 0.24, 0.36, 0.44);
  const scene2Opacity = calcOpacity(0.46, 0.53, 0.68, 0.76);
  const scene3Opacity = calcOpacity(0.78, 0.85, 0.95, 1.0);

  // Dynamic Telemetry calculation
  const getSpeed = () => {
    if (renderedFrame < 30) return (28 - (renderedFrame / 30) * 8).toFixed(1);
    if (renderedFrame < 70) return (20 - ((renderedFrame - 30) / 40) * 12).toFixed(1);
    if (renderedFrame < 100) return (8 - ((renderedFrame - 70) / 30) * 8).toFixed(1);
    return '0.0';
  };

  const getGear = () => {
    if (renderedFrame < 68) return 'D';
    if (renderedFrame < 100) return 'R';
    return 'P';
  };

  const getSteerAngle = () => {
    if (renderedFrame < 65) return '0.0°';
    if (renderedFrame < 82) {
      const p = (renderedFrame - 65) / 17;
      return `+${(p * 28.5).toFixed(1)}°`;
    }
    if (renderedFrame < 98) {
      const p = (renderedFrame - 82) / 16;
      return `-${(28.5 - p * 35).toFixed(1)}°`;
    }
    return '0.0°';
  };

  return (
    <section
      ref={containerRef}
      id="experience"
      className="relative w-full bg-[#080808]"
      style={{ height: '400vh' }}
    >
      {/* Sticky Fullscreen Canvas Viewport */}
      <div className="sticky top-0 w-full h-screen overflow-hidden flex flex-col justify-between">
        
        {/* Background Canvas */}
        <div className="absolute inset-0 z-0">
          <FrameCanvas ref={canvasRef} currentFrame={renderedFrame} />
        </div>

        {/* --- TOP HUD TELEMETRY BAR --- */}
        <div className="relative z-20 w-full px-6 md:px-12 pt-20 md:pt-24 flex items-center justify-between pointer-events-none">
          <div className="flex items-center space-x-3 text-[11px] font-mono tracking-widest text-neutral-400 bg-black/40 backdrop-blur-md px-3.5 py-1.5 rounded border border-white/10">
            <span className="w-2 h-2 rounded-full bg-[#2ee6ca] animate-pulse" />
            <span className="text-white font-medium">PARKX SIM_V2</span>
            <span className="text-neutral-600">|</span>
            <span className="text-[#2ee6ca]">FRAME {String(renderedFrame + 1).padStart(3, '0')}</span>
            <span className="hidden sm:inline text-neutral-500">/ 150</span>
          </div>

          {/* Telemetry Readouts */}
          <div className="hidden sm:flex items-center space-x-6 text-[11px] font-mono tracking-wider text-neutral-400 bg-black/40 backdrop-blur-md px-4 py-1.5 rounded border border-white/10">
            <div className="flex items-center space-x-2">
              <Gauge className="w-3.5 h-3.5 text-[#2ee6ca]" />
              <span>SPEED:</span>
              <span className="text-white font-semibold">{getSpeed()} km/h</span>
            </div>
            <div className="flex items-center space-x-2">
              <Navigation className="w-3.5 h-3.5 text-[#2ee6ca]" />
              <span>STEER:</span>
              <span className="text-white font-semibold">{getSteerAngle()}</span>
            </div>
            <div className="flex items-center space-x-1.5 pl-2 border-l border-white/10">
              <span className="text-neutral-500">GEAR:</span>
              <div className="flex items-center space-x-1">
                {['P', 'R', 'N', 'D'].map((g) => {
                  const active = getGear() === g;
                  return (
                    <span
                      key={g}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                        active
                          ? 'bg-[#2ee6ca] text-black shadow-[0_0_8px_rgba(46,230,202,0.8)]'
                          : 'text-neutral-600'
                      }`}
                    >
                      {g}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* --- CENTER SYNCHRONIZED CINEMATIC STATEMENTS --- */}
        <div className="relative z-10 w-full max-w-5xl mx-auto px-6 md:px-12 flex-1 flex items-center pointer-events-none">
          
          {/* HERO OVERLAY (Scroll 0% - 15%) */}
          <Hero
            opacity={heroOpacity}
            onExploreClick={() => window.scrollBy({ top: window.innerHeight, behavior: 'smooth' })}
          />

          {/* SCENE 1: SEE. THINK. PARK. (Scroll 20% - 40%) */}
          <div
            className="absolute inset-0 flex flex-col justify-center px-6 md:px-12 transition-opacity duration-300"
            style={{
              opacity: scene1Opacity,
              transform: `translateY(${(1 - scene1Opacity) * 20}px)`,
            }}
          >
            <div className="space-y-3 max-w-xl">
              <p className="text-xs font-mono tracking-widest text-[#2ee6ca] uppercase">
                Phase 01 // Spatial Awareness
              </p>
              <h2 className="font-display text-4xl sm:text-6xl md:text-7xl font-bold tracking-tight text-white uppercase leading-tight">
                SEE. <br />
                THINK. <br />
                <span className="text-[#2ee6ca]">PARK.</span>
              </h2>
              <p className="text-sm sm:text-base text-neutral-300 font-light max-w-md pt-2">
                Sub-millimeter sensor fusion reads curb topology, nearby obstacles, and lane demarcations in real time.
              </p>
            </div>
          </div>

          {/* SCENE 2: PRECISION MEETS INTELLIGENCE (Scroll 45% - 72%) */}
          <div
            className="absolute inset-0 flex flex-col justify-center items-end text-right px-6 md:px-12 transition-opacity duration-300"
            style={{
              opacity: scene2Opacity,
              transform: `translateY(${(1 - scene2Opacity) * 20}px)`,
            }}
          >
            <div className="space-y-3 max-w-xl">
              <p className="text-xs font-mono tracking-widest text-[#2ee6ca] uppercase">
                Phase 02 // Autonomous Trajectory
              </p>
              <h2 className="font-display text-4xl sm:text-6xl md:text-7xl font-bold tracking-tight text-white uppercase leading-tight">
                PRECISION <br />
                MEETS <br />
                <span className="text-[#2ee6ca]">INTELLIGENCE.</span>
              </h2>
              <p className="text-sm sm:text-base text-neutral-300 font-light max-w-md ml-auto pt-2">
                Clothoid trajectory planning calculates reverse wheel turn ratios to achieve zero-hesitation parallel alignment.
              </p>
            </div>
          </div>

          {/* SCENE 3: PARKING, REIMAGINED (Scroll 75% - 95%) */}
          <div
            className="absolute inset-0 flex flex-col justify-center px-6 md:px-12 transition-opacity duration-300"
            style={{
              opacity: scene3Opacity,
              transform: `translateY(${(1 - scene3Opacity) * 20}px)`,
            }}
          >
            <div className="space-y-3 max-w-xl">
              <p className="text-xs font-mono tracking-widest text-[#2ee6ca] uppercase">
                Phase 03 // Bay Lock Complete
              </p>
              <h2 className="font-display text-4xl sm:text-6xl md:text-7xl font-bold tracking-tight text-white uppercase leading-tight">
                PARKING, <br />
                <span className="text-[#2ee6ca]">REIMAGINED.</span>
              </h2>
              <p className="text-sm sm:text-base text-neutral-300 font-light max-w-md pt-2">
                Maneuver complete. Zero curb friction, optimal safety margin, and vehicle securely placed in the target slot.
              </p>
            </div>
          </div>

        </div>

        {/* --- BOTTOM HUD & SCROLL INDICATOR --- */}
        <div className="relative z-20 w-full px-6 md:px-12 pb-8 md:pb-12 flex items-end justify-between pointer-events-none">
          {/* Scroll Down Prompt (visible mostly at start) */}
          <div
            className="transition-opacity duration-300 flex items-center space-x-3 text-xs font-mono tracking-widest text-neutral-400 uppercase"
            style={{ opacity: Math.max(0, 1 - scrollProgress * 5) }}
          >
            <span className="p-2 rounded-full border border-white/10 bg-black/40 animate-bounce">
              <ArrowDown className="w-3.5 h-3.5 text-[#2ee6ca]" />
            </span>
            <span>Scroll to Explore Sequence</span>
          </div>

          {/* Timeline / Progress Bar */}
          <div className="flex flex-col items-end space-y-1.5 ml-auto">
            <div className="flex items-center space-x-2 text-[10px] font-mono tracking-widest text-neutral-400">
              <span>MANEUVER PROGRESS</span>
              <span className="text-[#2ee6ca] font-semibold">{Math.round(scrollProgress * 100)}%</span>
            </div>
            <div className="w-36 sm:w-48 h-1 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-[#2ee6ca]/70 to-[#2ee6ca] transition-all duration-75"
                style={{ width: `${Math.round(scrollProgress * 100)}%` }}
              />
            </div>
          </div>
        </div>

      </div>

      {/* Post-Animation Transition Statement */}
      <div className="relative z-30 w-full py-28 px-6 md:px-12 bg-gradient-to-b from-transparent via-[#080808] to-[#080808] text-center">
        <div className="max-w-4xl mx-auto space-y-6">
          <p className="text-xs font-mono tracking-widest text-[#2ee6ca] uppercase">
            ParkX Simulation Framework
          </p>
          <h2 className="font-display text-4xl sm:text-6xl md:text-7xl font-bold tracking-tight text-white uppercase leading-tight">
            PARKX INTELLIGENCE <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-neutral-200 to-neutral-500">
              IN MOTION.
            </span>
          </h2>
          <p className="text-base sm:text-lg text-neutral-300 font-light max-w-2xl mx-auto">
            A smarter approach to autonomous parking simulation. Bridging perception, mathematical trajectory calculation, and vehicle robotics.
          </p>
          <div className="pt-4">
            <a
              href="#about"
              className="inline-flex items-center space-x-2 text-xs font-mono tracking-widest uppercase text-neutral-400 hover:text-[#2ee6ca] transition-colors"
            >
              <span>Explore Technology</span>
              <ArrowDown className="w-3.5 h-3.5 text-[#2ee6ca]" />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
