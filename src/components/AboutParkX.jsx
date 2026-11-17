import React, { useRef, useEffect, useState } from 'react';
import { ShieldAlert, Clock, MessageSquare, Sparkles, QrCode, ArrowRight } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export default function AboutParkX({ onGetStarted }) {
  const sectionRef = useRef(null);
  const [isVisible, setIsVisible] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const { user, openSignup } = useAuth();

  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      setPrefersReducedMotion(mediaQuery.matches);
      const listener = (e) => setPrefersReducedMotion(e.matches);
      mediaQuery.addEventListener?.('change', listener);
      return () => mediaQuery.removeEventListener?.('change', listener);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.IntersectionObserver !== 'function') {
      setIsVisible(true);
      return;
    }

    const observer = new window.IntersectionObserver(
      ([entry]) => {
        // Trigger reveal when section enters viewport
        if (entry.isIntersecting) {
          setIsVisible(true);
        }
      },
      { threshold: 0.05, rootMargin: '0px 0px -20px 0px' }
    );

    if (sectionRef.current) {
      observer.observe(sectionRef.current);
    }

    return () => observer.disconnect();
  }, []);

  const handleActionClick = () => {
    if (onGetStarted) {
      onGetStarted();
    } else if (!user) {
      openSignup();
    }
  };

  const getTransitionStyle = (delayMs = 0) => {
    if (prefersReducedMotion) {
      return { opacity: 1, transform: 'none' };
    }
    return {
      transition: `opacity 800ms cubic-bezier(0.16, 1, 0.3, 1) ${delayMs}ms, transform 800ms cubic-bezier(0.16, 1, 0.3, 1) ${delayMs}ms`,
      opacity: isVisible ? 1 : 0,
      transform: isVisible ? 'translateY(0)' : 'translateY(32px)',
    };
  };

  return (
    <section
      ref={sectionRef}
      id="about"
      className="relative z-10 w-full max-w-7xl mx-auto px-4 sm:px-6 md:px-12 py-16 sm:py-24 md:py-32 scroll-mt-24 sm:scroll-mt-28"
      aria-label="About ParkX"
    >
      <div className="relative rounded-3xl bg-[#0c0c0c]/80 backdrop-blur-xl border border-white/[0.08] p-8 sm:p-12 md:p-16 shadow-[0_30px_100px_rgba(0,0,0,0.8)] overflow-hidden">
        {/* Subtle ambient gradient flare */}
        <div className="absolute top-0 right-0 w-96 h-96 bg-[#2ee6ca]/5 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-0 w-96 h-96 bg-indigo-500/5 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 max-w-4xl">
          {/* Eyebrow Badge */}
          <div
            style={getTransitionStyle(0)}
            className="inline-flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-[#2ee6ca]/10 border border-[#2ee6ca]/30 text-[#2ee6ca] text-xs font-mono tracking-widest uppercase mb-6"
          >
            <Sparkles className="w-3.5 h-3.5 text-[#2ee6ca]" />
            <span>About ParkX</span>
          </div>

          {/* Main Heading */}
          <h2
            style={getTransitionStyle(100)}
            className="font-display text-4xl sm:text-6xl md:text-7xl font-bold tracking-tight text-white uppercase leading-[1.02] mb-6"
          >
            Parking problems?{' '}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#2ee6ca] via-teal-300 to-white">
              Sorted.
            </span>
          </h2>

          {/* Description */}
          <p
            style={getTransitionStyle(200)}
            className="text-base sm:text-lg md:text-xl text-neutral-300 font-light leading-relaxed max-w-3xl mb-12"
          >
            ParkX connects vehicle owners and visitors through a simple QR code. No awkward searching for owners or sharing phone numbers. Just scan, send a message, and get things moving.
          </p>

          {/* 3 Highlights Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 pt-2">
            {/* Highlight 1: Smart Priority Alerts */}
            <div
              style={getTransitionStyle(300)}
              className="group p-6 rounded-2xl bg-white/[0.02] hover:bg-white/[0.04] border border-white/[0.06] hover:border-[#2ee6ca]/30 transition-all duration-300 flex flex-col justify-between"
            >
              <div>
                <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400 mb-4 group-hover:scale-105 transition-transform">
                  <ShieldAlert className="w-5 h-5" />
                </div>
                <h3 className="text-lg font-semibold text-white tracking-tight mb-2 flex items-center justify-between">
                  <span>Smart Priority Alerts</span>
                </h3>
                <p className="text-xs sm:text-sm text-neutral-400 font-light leading-relaxed">
                  Urgent parking blocks, security concerns, or accidental lights-on are prioritized so vehicle owners see critical notices immediately.
                </p>
              </div>
              <div className="pt-4 mt-4 border-t border-white/[0.04] text-[10px] font-mono tracking-wider text-neutral-500 uppercase">
                // Intelligent Urgency
              </div>
            </div>

            {/* Highlight 2: Owner Availability */}
            <div
              style={getTransitionStyle(400)}
              className="group p-6 rounded-2xl bg-white/[0.02] hover:bg-white/[0.04] border border-white/[0.06] hover:border-indigo-400/30 transition-all duration-300 flex flex-col justify-between"
            >
              <div>
                <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 mb-4 group-hover:scale-105 transition-transform">
                  <Clock className="w-5 h-5" />
                </div>
                <h3 className="text-lg font-semibold text-white tracking-tight mb-2 flex items-center justify-between">
                  <span>Owner Availability</span>
                </h3>
                <p className="text-xs sm:text-sm text-neutral-400 font-light leading-relaxed">
                  Owners can set their live status to Available, Busy, or Away with automated reply messages, setting clear expectations for visitors.
                </p>
              </div>
              <div className="pt-4 mt-4 border-t border-white/[0.04] text-[10px] font-mono tracking-wider text-neutral-500 uppercase">
                // Live Status & Auto-Reply
              </div>
            </div>

            {/* Highlight 3: Instant Communication */}
            <div
              style={getTransitionStyle(500)}
              className="group p-6 rounded-2xl bg-white/[0.02] hover:bg-white/[0.04] border border-white/[0.06] hover:border-emerald-400/30 transition-all duration-300 flex flex-col justify-between"
            >
              <div>
                <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 mb-4 group-hover:scale-105 transition-transform">
                  <MessageSquare className="w-5 h-5" />
                </div>
                <h3 className="text-lg font-semibold text-white tracking-tight mb-2 flex items-center justify-between">
                  <span>Instant Communication</span>
                </h3>
                <p className="text-xs sm:text-sm text-neutral-400 font-light leading-relaxed">
                  Two-way messaging through an anonymous browser pass. Visitors never need to install an app or share personal phone numbers.
                </p>
              </div>
              <div className="pt-4 mt-4 border-t border-white/[0.04] text-[10px] font-mono tracking-wider text-neutral-500 uppercase">
                // Anonymous Web Pass
              </div>
            </div>
          </div>

          {/* Bottom Action strip */}
          <div
            style={getTransitionStyle(600)}
            className="mt-10 pt-8 border-t border-white/[0.06] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"
          >
            <div className="flex items-center space-x-3 text-xs font-mono text-neutral-400">
              <span className="w-2 h-2 rounded-full bg-[#2ee6ca] animate-pulse" />
              <span>Available for all vehicle types — Cars, EVs, Bikes, and Commercial.</span>
            </div>

            <button
              onClick={handleActionClick}
              className="inline-flex items-center space-x-2 px-5 py-2.5 rounded-xl bg-[#2ee6ca] hover:bg-[#28d1b7] text-black font-mono text-xs font-semibold uppercase tracking-wider transition-all shadow-[0_0_20px_rgba(46,230,202,0.25)] group"
            >
              <span>{user ? 'Open Garage Telemetry' : 'Get Your Vehicle QR Pass'}</span>
              <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
