import React from 'react';
import { ArrowDown, Sparkles } from 'lucide-react';

export default function Hero({ onExploreClick }) {
  return (
    <section id="hero" className="relative min-h-screen flex flex-col justify-center px-6 md:px-12 max-w-7xl mx-auto pt-24 pb-16">
      <div className="space-y-6 max-w-2xl">
        <div className="inline-flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-[#2ee6ca]/10 border border-[#2ee6ca]/30 text-[#2ee6ca] text-xs font-mono tracking-widest uppercase">
          <Sparkles className="w-3.5 h-3.5 text-[#2ee6ca]" />
          <span>Next-Generation Autonomous Parking</span>
        </div>
        
        <h1 className="font-display text-6xl sm:text-8xl md:text-9xl font-bold tracking-tight text-white uppercase leading-[0.92]">
          THE FUTURE <br />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-white via-white/90 to-neutral-500">
            OF PARKING
          </span>
        </h1>
        
        <p className="text-lg sm:text-xl md:text-2xl text-neutral-300 font-light tracking-wide max-w-xl">
          Intelligent parking. Reimagined through cinematic autonomous trajectory control.
        </p>

        <div className="pt-6 flex items-center space-x-6">
          <button
            onClick={onExploreClick}
            className="group inline-flex items-center space-x-3 px-6 py-3.5 rounded bg-[#2ee6ca] hover:bg-[#28d1b7] text-black font-mono text-xs uppercase tracking-widest font-semibold transition-all shadow-[0_0_30px_rgba(46,230,202,0.3)]"
          >
            <span>Explore Experience</span>
            <ArrowDown className="w-4 h-4 group-hover:translate-y-1 transition-transform" />
          </button>
          
          <span className="text-xs font-mono text-neutral-400 tracking-wider uppercase hidden sm:inline">
            // Scroll down to drive sequence
          </span>
        </div>
      </div>
    </section>
  );
}
