import React from 'react';
import { Gauge, Navigation } from 'lucide-react';

export default function TelemetryHUD({ renderedFrame = 0, scrollProgress = 0, isDocked = false }) {
  // Speed calculation
  const getSpeed = () => {
    if (renderedFrame < 30) return (28 - (renderedFrame / 30) * 8).toFixed(1);
    if (renderedFrame < 70) return (20 - ((renderedFrame - 30) / 40) * 12).toFixed(1);
    if (renderedFrame < 100) return (8 - ((renderedFrame - 70) / 30) * 8).toFixed(1);
    return '0.0';
  };

  // Gear calculation
  const getGear = () => {
    if (renderedFrame < 68) return 'D';
    if (renderedFrame < 100) return 'R';
    return 'P';
  };

  // Steering angle calculation
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
    <div className="fixed top-20 left-0 right-0 z-40 px-6 md:px-12 pointer-events-none transition-opacity duration-500">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        
        {/* Left: Frame status badge */}
        <div className="flex items-center space-x-3 text-[11px] font-mono tracking-widest text-neutral-300 bg-black/60 backdrop-blur-xl px-3.5 py-1.5 rounded-md border border-white/10 shadow-lg">
          <span className="w-2 h-2 rounded-full bg-[#2ee6ca] animate-pulse" />
          <span className="text-white font-medium">PARKX SIM_V2</span>
          <span className="text-neutral-600">|</span>
          <span className="text-[#2ee6ca] font-semibold">FRAME {String(renderedFrame + 1).padStart(3, '0')}</span>
          <span className="text-neutral-500 hidden sm:inline">/ 150</span>
        </div>

        {/* Right: Telemetry Readouts */}
        <div className="flex items-center space-x-4 sm:space-x-6 text-[11px] font-mono tracking-wider text-neutral-300 bg-black/60 backdrop-blur-xl px-4 py-1.5 rounded-md border border-white/10 shadow-lg">
          <div className="hidden sm:flex items-center space-x-2">
            <Gauge className="w-3.5 h-3.5 text-[#2ee6ca]" />
            <span className="text-neutral-400">SPEED:</span>
            <span className="text-white font-semibold">{getSpeed()} km/h</span>
          </div>

          <div className="flex items-center space-x-2">
            <Navigation className="w-3.5 h-3.5 text-[#2ee6ca]" />
            <span className="text-neutral-400 hidden sm:inline">STEER:</span>
            <span className="text-white font-semibold">{getSteerAngle()}</span>
          </div>

          <div className="flex items-center space-x-1.5 pl-2 border-l border-white/10">
            <span className="text-neutral-500 hidden sm:inline">GEAR:</span>
            <div className="flex items-center space-x-1">
              {['P', 'R', 'N', 'D'].map((g) => {
                const active = getGear() === g;
                return (
                  <span
                    key={g}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition-all ${
                      active
                        ? 'bg-[#2ee6ca] text-black shadow-[0_0_10px_rgba(46,230,202,0.8)]'
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
    </div>
  );
}
