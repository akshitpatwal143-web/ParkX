import React from 'react';
import { ArrowRight, Terminal, Sparkles } from 'lucide-react';

export default function CTA() {
  const scrollTo = (id) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <section className="relative w-full py-36 px-6 md:px-12 bg-[#060606] overflow-hidden border-t border-white/[0.08]">
      {/* Background with Darkened Final Parking Frame */}
      <div
        className="absolute inset-0 z-0 bg-cover bg-center opacity-25 filter blur-[2px] scale-105"
        style={{ backgroundImage: `url('/frames/frame-150.jpg')` }}
      />
      
      {/* Luxury Cinematic Gradient Overlays */}
      <div className="absolute inset-0 z-0 bg-gradient-to-t from-[#080808] via-[#080808]/85 to-[#080808]" />
      <div className="absolute inset-0 z-0 bg-radial-at-c from-transparent via-[#080808]/70 to-[#080808]" />

      <div className="relative z-10 max-w-5xl mx-auto text-center space-y-8">
        <div className="inline-flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-[#2ee6ca]/10 border border-[#2ee6ca]/30 text-[#2ee6ca] text-xs font-mono tracking-widest uppercase">
          <Sparkles className="w-3.5 h-3.5" />
          <span>Next-Generation Autonomous Vehicle Framework</span>
        </div>

        <h2 className="font-display text-5xl sm:text-7xl md:text-8xl font-bold tracking-tight text-white uppercase leading-[0.95]">
          READY TO <br />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-white via-[#2ee6ca] to-neutral-400">
            PARK DIFFERENTLY?
          </span>
        </h2>

        <p className="text-lg sm:text-xl text-neutral-300 font-light max-w-2xl mx-auto">
          Experience the autonomous trajectory calculation in real time or integrate the simulation pipeline into your vehicle stack.
        </p>

        <div className="pt-6 flex flex-col sm:flex-row items-center justify-center gap-4">
          <button
            onClick={() => scrollTo('demo')}
            className="group relative inline-flex items-center space-x-3 px-8 py-4 rounded bg-[#2ee6ca] hover:bg-[#28d1b7] text-black font-mono text-xs uppercase tracking-widest font-semibold transition-all shadow-[0_0_35px_rgba(46,230,202,0.35)] hover:scale-105"
          >
            <span>Explore ParkX Demo</span>
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1.5 transition-transform duration-300" />
          </button>

          <button
            onClick={() => scrollTo('technology')}
            className="inline-flex items-center space-x-2 px-8 py-4 rounded border border-white/15 hover:border-white/30 bg-white/[0.02] text-white font-mono text-xs uppercase tracking-widest transition-colors"
          >
            <Terminal className="w-4 h-4 text-[#2ee6ca]" />
            <span>View Architecture</span>
          </button>
        </div>

        <div className="pt-8 text-xs font-mono text-neutral-500 uppercase tracking-widest">
          // PARKX AUTONOMOUS RESEARCH • PRODUCTION GRADE ARCHITECTURE
        </div>
      </div>
    </section>
  );
}
