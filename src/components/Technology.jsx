import React, { useState } from 'react';
import { Eye, Route, BrainCircuit, Box, ArrowUpRight } from 'lucide-react';

export default function Technology() {
  const [activeCard, setActiveCard] = useState(null);

  const techCards = [
    {
      id: '01',
      title: 'COMPUTER VISION',
      subtitle: 'Understanding the environment.',
      icon: Eye,
      details: 'Deep neural perception networks process dual-camera and LiDAR point clouds to segment curbs, painted parking lines, pedestrian boundaries, and vehicle vertices in real-time at 60 FPS.',
      telemetry: ['Resolution: 1280x720', 'Latency: <8ms', 'Point Cloud: 120k pts/sec']
    },
    {
      id: '02',
      title: 'PATH PLANNING',
      subtitle: 'Finding the optimal trajectory.',
      icon: Route,
      details: 'Hybrid A* search coupled with continuous-curvature Reeds-Shepp and Clothoid curves generates kinematically feasible trajectories respecting steering lock limits and non-holonomic vehicle constraints.',
      telemetry: ['Clothoid Curvature', 'Reeds-Shepp Paths', 'Resolution: 2.5cm grid']
    },
    {
      id: '03',
      title: 'INTELLIGENT DECISION',
      subtitle: 'Choosing when and where to move.',
      icon: BrainCircuit,
      details: 'Deterministic finite-state machines coordinate speed profiling, obstacle arbitration, and emergency halts. Continuously predicts the collision envelope before engaging steering actuators.',
      telemetry: ['FSM Cycles: 200Hz', 'Safety Margin: 0.35m', 'Arbitration: Real-time']
    },
    {
      id: '04',
      title: 'SIMULATION ENGINE',
      subtitle: 'Testing decisions before execution.',
      icon: Box,
      details: 'High-fidelity synthetic physics sandbox validates maneuvers across thousands of randomized slot dimensions, weather conditions, lighting angles, and curb heights prior to vehicle deployment.',
      telemetry: ['Simulated Runs: 100k+', 'Accuracy: 99.8%', 'Physics: Rigid Body 2D/3D']
    }
  ];

  return (
    <section id="technology" className="relative w-full py-32 px-6 md:px-12 bg-transparent">
      <div className="max-w-7xl mx-auto">
        
        {/* Section Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between mb-20 pb-8 border-b border-white/[0.08]">
          <div>
            <div className="flex items-center space-x-3 mb-4">
              <span className="w-1.5 h-1.5 rounded-full bg-[#2ee6ca]" />
              <span className="text-xs font-mono tracking-widest text-[#2ee6ca] uppercase">
                02 // Core Architecture
              </span>
            </div>
            <h2 className="font-display text-5xl sm:text-6xl md:text-7xl font-bold tracking-tight text-white uppercase leading-none">
              ENGINEERED FOR <br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-white via-neutral-300 to-neutral-600">
                AUTONOMOUS RIGOR.
              </span>
            </h2>
          </div>

          <div className="mt-6 md:mt-0 text-right">
            <span className="text-xs font-mono text-neutral-400 uppercase tracking-widest">
              SYSTEM MATRIX // 4 PILLARS
            </span>
          </div>
        </div>

        {/* 4 Large Luxury Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {techCards.map((card) => {
            const Icon = card.icon;
            const isHovered = activeCard === card.id;

            return (
              <div
                key={card.id}
                onMouseEnter={() => setActiveCard(card.id)}
                onMouseLeave={() => setActiveCard(null)}
                className={`group relative p-8 sm:p-12 rounded-xl bg-[#080808]/85 backdrop-blur-2xl border transition-all duration-500 flex flex-col justify-between overflow-hidden shadow-2xl ${
                  isHovered
                    ? 'border-[#2ee6ca]/60 shadow-[0_0_40px_rgba(46,230,202,0.12)] -translate-y-1'
                    : 'border-white/[0.08] hover:border-white/20'
                }`}
              >
                {/* Background Subtle Gradient */}
                <div
                  className={`absolute inset-0 bg-gradient-to-br from-[#2ee6ca]/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none`}
                />

                {/* Card Top: Number & Icon */}
                <div>
                  <div className="flex items-center justify-between pb-8">
                    <span className="font-mono text-xs text-neutral-400 tracking-widest group-hover:text-[#2ee6ca] transition-colors">
                      // {card.id}
                    </span>
                    <div className="w-12 h-12 rounded-lg bg-white/[0.03] border border-white/10 flex items-center justify-center text-neutral-300 group-hover:border-[#2ee6ca]/40 group-hover:text-[#2ee6ca] group-hover:bg-[#2ee6ca]/10 transition-all duration-300">
                      <Icon className="w-5 h-5" />
                    </div>
                  </div>

                  {/* Title & Subtitle */}
                  <div className="space-y-3">
                    <h3 className="font-display text-2xl sm:text-3xl font-bold text-white uppercase tracking-tight group-hover:text-white transition-colors">
                      {card.title}
                    </h3>
                    <p className="text-base font-medium text-[#2ee6ca] tracking-wide">
                      {card.subtitle}
                    </p>
                    <p className="text-sm text-neutral-400 font-light leading-relaxed pt-2">
                      {card.details}
                    </p>
                  </div>
                </div>

                {/* Card Bottom: Telemetry Micro-Badges */}
                <div className="pt-10 border-t border-white/[0.06] mt-8">
                  <div className="flex flex-wrap gap-2">
                    {card.telemetry.map((t, idx) => (
                      <span
                        key={idx}
                        className="px-2.5 py-1 rounded bg-white/[0.03] border border-white/[0.06] text-[10px] font-mono text-neutral-400 group-hover:border-[#2ee6ca]/30 group-hover:text-neutral-300 transition-colors"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>

              </div>
            );
          })}
        </div>

      </div>
    </section>
  );
}
