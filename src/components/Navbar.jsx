import React, { useState, useEffect } from 'react';

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-500 ${
        scrolled
          ? 'bg-[#080808]/75 backdrop-blur-xl border-b border-white/[0.06] py-3.5 shadow-2xl'
          : 'bg-gradient-to-b from-black/80 via-black/20 to-transparent py-5'
      }`}
    >
      <div className="max-w-7xl mx-auto px-6 md:px-12 flex items-center justify-between">
        
        {/* Luxury Brand Wordmark */}
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="group flex items-center space-x-3 text-left focus:outline-none"
        >
          <div className="w-8 h-8 rounded border border-white/20 bg-white/[0.03] flex items-center justify-center group-hover:border-[#2ee6ca] group-hover:bg-[#2ee6ca]/10 transition-all duration-300">
            <span className="font-mono text-xs font-bold tracking-widest text-[#2ee6ca]">PX</span>
          </div>
          <div>
            <span className="font-display font-semibold text-lg md:text-xl tracking-[0.22em] text-white group-hover:text-white/90 transition-colors uppercase">
              PARK<span className="text-[#2ee6ca]">X</span>
            </span>
            <span className="hidden sm:block text-[9px] font-mono tracking-widest text-neutral-400 uppercase -mt-0.5">
              Autonomous Systems
            </span>
          </div>
        </button>

        {/* Minimal Luxury Automotive Status Indicator */}
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/[0.02] backdrop-blur-md">
            <span className="w-1.5 h-1.5 rounded-full bg-[#2ee6ca] animate-pulse" />
            <span className="text-[10px] font-mono tracking-widest text-neutral-300 uppercase">
              EXPERIENCE READY
            </span>
          </div>
        </div>

      </div>
    </header>
  );
}
