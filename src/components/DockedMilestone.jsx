import React from 'react';
import { ArrowDown, CheckCircle2, ShieldCheck, Gauge } from 'lucide-react';

export default function DockedMilestone() {
  const scrollTo = (id) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <section className="relative w-full py-36 px-6 md:px-12 bg-transparent">
      <div className="max-w-7xl mx-auto">
        
        {/* Milestone Card */}
        <div className="rounded-2xl bg-[#080808]/90 backdrop-blur-2xl border border-[#2ee6ca]/40 p-8 sm:p-14 shadow-[0_0_60px_rgba(46,230,202,0.12)]">
          <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8 pb-10 border-b border-white/[0.08]">
            <div className="space-y-3">
              <div className="flex items-center space-x-2 text-xs font-mono text-[#2ee6ca] uppercase tracking-widest">
                <CheckCircle2 className="w-4 h-4 text-[#2ee6ca]" />
                <span>PHASE 03 // TRAJECTORY COMPLETE</span>
              </div>
              <h2 className="font-display text-4xl sm:text-6xl md:text-7xl font-bold text-white uppercase tracking-tight leading-none">
                PARKING, <br />
                <span className="text-[#2ee6ca]">REIMAGINED.</span>
              </h2>
            </div>

            <div className="text-right">
              <span className="text-xs font-mono text-neutral-400 uppercase tracking-widest">
                FINAL BAY COORDINATES // LOCKED
              </span>
              <div className="text-2xl font-mono font-bold text-white mt-1">
                BAY [P1] • 0.00 km/h
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 py-8 border-b border-white/[0.08] text-xs font-mono">
            <div>
              <span className="text-neutral-500 uppercase">LATERAL OFFSET</span>
              <div className="text-lg font-bold text-white mt-1">+24 mm</div>
            </div>
            <div>
              <span className="text-neutral-500 uppercase">ANGULAR HEADING</span>
              <div className="text-lg font-bold text-[#2ee6ca] mt-1">0.0° ZERO YAW</div>
            </div>
            <div>
              <span className="text-neutral-500 uppercase">CURB CLEARANCE</span>
              <div className="text-lg font-bold text-white mt-1">55 mm</div>
            </div>
            <div>
              <span className="text-neutral-500 uppercase">GEAR STATE</span>
              <div className="text-lg font-bold text-emerald-400 mt-1">[P] PARK LOCK</div>
            </div>
          </div>

          <div className="pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-sm text-neutral-400 font-light max-w-xl">
              The autonomous maneuver has achieved sub-millimeter positioning with zero tire scrub and deterministic margin. Now, test the real-time calculation engine yourself.
            </p>

            <button
              onClick={() => scrollTo('demo')}
              className="inline-flex items-center space-x-2 px-6 py-3 rounded bg-[#2ee6ca] hover:bg-[#28d1b7] text-black font-mono text-xs font-semibold uppercase tracking-widest transition-all shadow-[0_0_20px_rgba(46,230,202,0.3)]"
            >
              <span>Test Demo Sandbox</span>
              <ArrowDown className="w-4 h-4" />
            </button>
          </div>
        </div>

      </div>
    </section>
  );
}
