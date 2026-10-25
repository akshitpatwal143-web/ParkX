import React from 'react';
import { ArrowUpRight, Compass, ShieldAlert, Cpu } from 'lucide-react';

export default function SectionIntro() {
  const comparisonData = [
    {
      today: 'Manual parking maneuvers',
      parkx: 'Intelligent autonomous docking',
      desc: 'Replaces human estimation with continuous radar and vision geometry.'
    },
    {
      today: 'Limited situational precision',
      parkx: 'Millimeter automated precision',
      desc: 'Calculates curb offsets down to millimeter tolerances with zero wheel rash.'
    },
    {
      today: 'Reactive human panic & delay',
      parkx: 'Deterministic algorithmic decisions',
      desc: 'Predictive collision avoidance evaluated across 120 trajectory iterations per second.'
    },
    {
      today: 'Trial & error steering adjustments',
      parkx: 'Planned continuous-curvature paths',
      desc: 'Clothoid spiral path planning ensures uninterrupted, smooth wheel steering.'
    }
  ];

  return (
    <section id="about" className="relative w-full py-32 px-6 md:px-12 bg-transparent">
      <div className="max-w-7xl mx-auto">
        
        {/* Section Header Badge */}
        <div className="flex items-center space-x-3 mb-10">
          <span className="w-1.5 h-1.5 rounded-full bg-[#2ee6ca]" />
          <span className="text-xs font-mono tracking-widest text-[#2ee6ca] uppercase">
            01 // Editorial Thesis
          </span>
        </div>

        {/* Large Editorial Heading */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-16 items-start pb-24 border-b border-white/[0.08]">
          <div className="lg:col-span-8">
            <h2 className="font-display text-5xl sm:text-7xl md:text-8xl font-bold tracking-tight text-white uppercase leading-[0.95]">
              PARKING <br />
              SHOULD BE <br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-white via-[#2ee6ca] to-neutral-500">
                INTELLIGENT.
              </span>
            </h2>
          </div>

          <div className="lg:col-span-4 space-y-6 pt-2 lg:pt-4">
            <p className="text-lg md:text-xl text-neutral-300 font-light leading-relaxed">
              ParkX explores how intelligent systems transform parking from an anxiety-inducing manual maneuver into a seamless, automated experience.
            </p>
            <p className="text-sm text-neutral-400 font-light leading-relaxed">
              By uniting environmental perception, real-time spatial path generation, and deterministic vehicle dynamics, ParkX redefines precision at zero velocity.
            </p>
            <div className="pt-4 flex items-center space-x-6 text-xs font-mono text-neutral-400">
              <div className="flex items-center space-x-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                <span>Zero Curb Contact</span>
              </div>
              <div className="flex items-center space-x-2">
                <span className="w-2 h-2 rounded-full bg-[#2ee6ca]" />
                <span>Sub-5cm Tolerance</span>
              </div>
            </div>
          </div>
        </div>

        {/* Problem → Solution: High-End Editorial Comparison */}
        <div className="pt-24">
          <div className="flex flex-col md:flex-row md:items-end justify-between mb-16">
            <div>
              <p className="text-xs font-mono tracking-widest text-neutral-400 uppercase mb-2">
                Paradigm Shift
              </p>
              <h3 className="font-display text-3xl sm:text-4xl font-bold text-white uppercase tracking-tight">
                From Reactive Guesswork to Autonomous Certainty
              </h3>
            </div>
            <p className="text-xs font-mono text-[#2ee6ca] mt-4 md:mt-0 tracking-wider uppercase">
              // EVOLUTION OF THE PARKING VECTOR
            </p>
          </div>

          {/* Editorial Columns */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 lg:gap-12">
            {/* Column 1: Today */}
            <div className="p-8 sm:p-10 rounded-xl bg-[#080808]/85 backdrop-blur-2xl border border-white/10 shadow-2xl relative overflow-hidden">
              <div className="flex items-center justify-between pb-8 border-b border-white/[0.08]">
                <div>
                  <span className="text-[10px] font-mono tracking-widest text-neutral-400 uppercase">Legacy Status</span>
                  <h4 className="font-display text-2xl sm:text-3xl font-bold text-neutral-400 uppercase tracking-tight">
                    TODAY
                  </h4>
                </div>
                <div className="w-10 h-10 rounded-full border border-white/10 flex items-center justify-center text-neutral-400">
                  <ShieldAlert className="w-5 h-5" />
                </div>
              </div>

              <div className="space-y-8 pt-8">
                {comparisonData.map((item, idx) => (
                  <div key={idx} className="group">
                    <div className="text-xs font-mono text-neutral-400 mb-1">0{idx + 1} // CONSTRAINT</div>
                    <div className="text-lg font-medium text-neutral-300 group-hover:text-white transition-colors">
                      {item.today}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Column 2: ParkX */}
            <div className="p-8 sm:p-10 rounded-xl bg-[#0b0b0b]/85 backdrop-blur-2xl border border-[#2ee6ca]/30 relative overflow-hidden shadow-[0_0_50px_rgba(46,230,202,0.1)]">
              {/* Subtle accent corner glow */}
              <div className="absolute top-0 right-0 w-48 h-48 bg-[#2ee6ca]/10 rounded-full blur-3xl pointer-events-none" />

              <div className="flex items-center justify-between pb-8 border-b border-[#2ee6ca]/20">
                <div>
                  <span className="text-[10px] font-mono tracking-widest text-[#2ee6ca] uppercase">Intelligent Paradigm</span>
                  <h4 className="font-display text-2xl sm:text-3xl font-bold text-white uppercase tracking-tight">
                    PARK<span className="text-[#2ee6ca]">X</span>
                  </h4>
                </div>
                <div className="w-10 h-10 rounded-full bg-[#2ee6ca]/10 border border-[#2ee6ca]/40 flex items-center justify-center text-[#2ee6ca]">
                  <Cpu className="w-5 h-5" />
                </div>
              </div>

              <div className="space-y-8 pt-8">
                {comparisonData.map((item, idx) => (
                  <div key={idx} className="group">
                    <div className="text-xs font-mono text-[#2ee6ca]/80 mb-1">0{idx + 1} // CAPABILITY</div>
                    <div className="text-lg font-medium text-white group-hover:text-[#2ee6ca] transition-colors">
                      {item.parkx}
                    </div>
                    <p className="text-xs text-neutral-400 font-light mt-1">
                      {item.desc}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>

        </div>

      </div>
    </section>
  );
}
