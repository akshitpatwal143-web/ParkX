import React from 'react';
import { Network, Sparkles, Globe2, Shield } from 'lucide-react';

export default function Vision() {
  const visionPillars = [
    {
      title: 'V2X INFRASTRUCTURE',
      desc: 'Seamless data interchange between curb sensor networks, parking beacons, and vehicle clusters.'
    },
    {
      title: 'HIGH-DENSITY OPTIMIZATION',
      desc: 'Enabling urban transit hubs to safely reclaim up to 35% spatial volume through zero-clearance automated staging.'
    },
    {
      title: 'ZERO-COLLISION GUARANTEE',
      desc: 'Continuous formal verification mathematics ensuring actuator actions are bounded by deterministic safety shields.'
    }
  ];

  return (
    <section id="vision" className="relative w-full py-36 px-6 md:px-12 bg-[#080808] border-t border-white/[0.06] overflow-hidden">
      {/* Background Ambience */}
      <div className="absolute top-0 right-1/4 w-96 h-96 bg-[#2ee6ca]/5 rounded-full blur-[120px] pointer-events-none" />

      <div className="max-w-7xl mx-auto">
        
        {/* Section Badge */}
        <div className="flex items-center space-x-3 mb-10">
          <span className="w-1.5 h-1.5 rounded-full bg-[#2ee6ca]" />
          <span className="text-xs font-mono tracking-widest text-[#2ee6ca] uppercase">
            05 // Future Horizon
          </span>
        </div>

        {/* Oversized Typography */}
        <div className="mb-20">
          <h2 className="font-display text-5xl sm:text-7xl md:text-8xl lg:text-9xl font-bold tracking-tight text-white uppercase leading-[0.9]">
            FROM <br />
            PARKING TO <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-white via-[#2ee6ca] to-neutral-500">
              AUTONOMOUS
            </span> <br />
            MOBILITY.
          </h2>
        </div>

        {/* Vision Narrative */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 pb-20 border-b border-white/[0.08]">
          <div className="lg:col-span-6">
            <p className="text-xl sm:text-2xl text-neutral-200 font-light leading-relaxed">
              ParkX is a step toward smarter interaction between vehicles, environments and intelligent systems.
            </p>
          </div>

          <div className="lg:col-span-6 space-y-4 text-neutral-400 font-light text-base leading-relaxed">
            <p>
              Parking is not an isolated terminal state; it is the critical convergence point where high-velocity driving transitions into spatial precision, pedestrian safety, and urban energy ecosystems.
            </p>
            <p>
              By solving the most geometrically constrained challenge in autonomous navigation—tight-quarter maneuvering without GPS reliance—we lay the groundwork for ubiquitous Level-4 robotic mobility.
            </p>
          </div>
        </div>

        {/* Vision Architecture Pillars */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 pt-16">
          {visionPillars.map((pillar, idx) => (
            <div key={idx} className="p-6 rounded-lg bg-white/[0.01] border border-white/[0.05] space-y-3">
              <span className="text-xs font-mono text-[#2ee6ca]">0{idx + 1} // ARCHITECTURE</span>
              <h3 className="font-display text-lg font-bold text-white uppercase tracking-wide">
                {pillar.title}
              </h3>
              <p className="text-sm text-neutral-400 font-light leading-relaxed">
                {pillar.desc}
              </p>
            </div>
          ))}
        </div>

      </div>
    </section>
  );
}
