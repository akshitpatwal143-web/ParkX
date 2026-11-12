import React, { useState, useEffect } from 'react';
import { LogIn, Rocket, Menu, X, User as UserIcon, LogOut, Car, Compass } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getAuthStatus } from '../context/authStatus';

export default function Navbar({ currentView = 'landing', onNavigateView }) {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { openLogin, openSignup, user, logout, isInitializing, authError } = useAuth();
  const authStatus = getAuthStatus(isInitializing, authError);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Close mobile menu when auth modal opens
  const handleSignIn = () => {
    setMobileOpen(false);
    openLogin();
  };
  const handleGetStarted = () => {
    setMobileOpen(false);
    openSignup();
  };
  const handleLogout = () => {
    setMobileOpen(false);
    logout();
    if (onNavigateView) onNavigateView('landing');
  };

  const handleGarageClick = () => {
    setMobileOpen(false);
    if (!user) {
      openLogin();
    } else if (onNavigateView) {
      onNavigateView('garage');
    }
  };

  const handleLandingClick = () => {
    setMobileOpen(false);
    if (onNavigateView) onNavigateView('landing');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-500 ${
        scrolled || currentView !== 'landing'
          ? 'bg-[#080808]/85 backdrop-blur-xl border-b border-white/[0.06] py-3.5 shadow-2xl'
          : 'bg-gradient-to-b from-black/80 via-black/20 to-transparent py-5'
      }`}
    >
      <div className="max-w-7xl mx-auto px-6 md:px-12 flex items-center justify-between">
        
        {/* Luxury Brand Wordmark */}
        <button
          onClick={handleLandingClick}
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

        {/* ── Right Side: Navigation + Status + Auth Buttons (Desktop) ── */}
        <div className="hidden md:flex items-center space-x-4">
          {/* Status Indicator */}
          <div className="flex items-center space-x-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/[0.02] backdrop-blur-md">
            <span className="w-1.5 h-1.5 rounded-full bg-[#2ee6ca] animate-pulse" />
            <span className="text-[10px] font-mono tracking-widest text-neutral-300 uppercase">
              {authStatus === 'loading'
                ? 'RESTORING SESSION'
                : authStatus === 'unavailable'
                ? 'AUTH SERVICE OFFLINE'
                : currentView === 'visitor'
                ? 'VISITOR TERMINAL'
                : currentView === 'garage'
                ? 'GARAGE TELEMETRY'
                : 'EXPERIENCE READY'}
            </span>
          </div>

          {/* View Toggles */}
          {user && (
            <div className="flex items-center space-x-2">
              <button
                onClick={handleLandingClick}
                className={`inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-mono tracking-wider uppercase transition-all ${
                  currentView === 'landing'
                    ? 'border border-[#2ee6ca]/40 bg-[#2ee6ca]/10 text-[#2ee6ca]'
                    : 'border border-white/[0.08] bg-white/[0.02] text-neutral-400 hover:text-white'
                }`}
              >
                <Compass className="w-3.5 h-3.5" />
                <span>Experience</span>
              </button>

              <button
                onClick={handleGarageClick}
                className={`inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-mono tracking-wider uppercase transition-all ${
                  currentView === 'garage'
                    ? 'border border-[#2ee6ca]/40 bg-[#2ee6ca]/10 text-[#2ee6ca]'
                    : 'border border-white/[0.08] bg-white/[0.02] text-neutral-400 hover:text-white'
                }`}
              >
                <Car className="w-3.5 h-3.5" />
                <span>My Garage</span>
              </button>
            </div>
          )}

          {isInitializing ? null : user ? (
            /* Logged-In User Badge & Logout */
            <div className="flex items-center space-x-3 pl-2 border-l border-white/[0.08]">
              <div className="flex items-center space-x-2 px-3 py-1.5 rounded-lg border border-[#2ee6ca]/30 bg-[#2ee6ca]/10 text-white text-xs font-mono">
                <UserIcon className="w-3.5 h-3.5 text-[#2ee6ca]" />
                <span className="font-medium tracking-wide max-w-[140px] truncate">
                  {user.fullName || user.email}
                </span>
              </div>
              <button
                onClick={handleLogout}
                className="group flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border border-white/[0.08] bg-white/[0.02] text-neutral-400 hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10 transition-all duration-300 text-xs font-mono tracking-widest uppercase"
                title="Sign out"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Exit</span>
              </button>
            </div>
          ) : (
            <>
              {/* Sign In — ghost / text button */}
              <button
                onClick={handleSignIn}
                className="group flex items-center space-x-2 px-4 py-2 rounded-lg border border-white/[0.08] bg-white/[0.02] text-neutral-300 hover:text-white hover:border-white/20 hover:bg-white/[0.06] transition-all duration-300 text-xs font-mono tracking-widest uppercase"
              >
                <LogIn className="w-3.5 h-3.5 opacity-60 group-hover:opacity-100 transition-opacity" />
                <span>Sign In</span>
              </button>

              {/* Get Started — prominent teal CTA */}
              <button
                onClick={handleGetStarted}
                className="group flex items-center space-x-2 px-5 py-2 rounded-lg bg-[#2ee6ca] hover:bg-[#28d1b7] active:bg-[#22b8a1] text-black font-mono text-xs uppercase tracking-widest font-semibold transition-all duration-300 shadow-[0_0_25px_rgba(46,230,202,0.2)] hover:shadow-[0_0_35px_rgba(46,230,202,0.35)]"
              >
                <span>Get Started</span>
                <Rocket className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
              </button>
            </>
          )}
        </div>

        {/* ── Mobile Hamburger ── */}
        <button
          onClick={() => setMobileOpen((v) => !v)}
          className="md:hidden p-2 rounded-lg border border-white/10 bg-white/[0.03] text-neutral-300 hover:text-white transition-colors"
          aria-label="Toggle navigation menu"
        >
          {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {/* ── Mobile Menu Dropdown ── */}
      <div
        className={`md:hidden overflow-hidden transition-all duration-300 ${
          mobileOpen ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'
        }`}
      >
        <div className="px-6 pt-4 pb-5 space-y-3 border-t border-white/[0.06] bg-[#080808]/95 backdrop-blur-xl">
          {/* Status */}
          <div className="flex items-center space-x-2 pb-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[#2ee6ca] animate-pulse" />
            <span className="text-[10px] font-mono tracking-widest text-neutral-400 uppercase">
              {authStatus === 'loading'
                ? 'RESTORING SESSION'
                : authStatus === 'unavailable'
                ? 'AUTH SERVICE OFFLINE'
                : currentView === 'visitor'
                ? 'VISITOR TERMINAL'
                : currentView === 'garage'
                ? 'GARAGE TELEMETRY'
                : 'EXPERIENCE READY'}
            </span>
          </div>

          {user && (
            <div className="grid grid-cols-2 gap-2 pb-2">
              <button
                onClick={handleLandingClick}
                className={`flex items-center justify-center space-x-1.5 py-2 rounded-lg text-xs font-mono uppercase tracking-wider ${
                  currentView === 'landing'
                    ? 'border border-[#2ee6ca]/40 bg-[#2ee6ca]/10 text-[#2ee6ca]'
                    : 'border border-white/[0.08] text-neutral-400'
                }`}
              >
                <Compass className="w-3.5 h-3.5" />
                <span>Experience</span>
              </button>
              <button
                onClick={handleGarageClick}
                className={`flex items-center justify-center space-x-1.5 py-2 rounded-lg text-xs font-mono uppercase tracking-wider ${
                  currentView === 'garage'
                    ? 'border border-[#2ee6ca]/40 bg-[#2ee6ca]/10 text-[#2ee6ca]'
                    : 'border border-white/[0.08] text-neutral-400'
                }`}
              >
                <Car className="w-3.5 h-3.5" />
                <span>My Garage</span>
              </button>
            </div>
          )}

          {isInitializing ? null : user ? (
            <div className="space-y-2">
              <div className="flex items-center space-x-2 px-3 py-2 rounded-lg bg-[#2ee6ca]/10 border border-[#2ee6ca]/30 text-white text-xs font-mono">
                <UserIcon className="w-4 h-4 text-[#2ee6ca]" />
                <span className="truncate">{user.fullName || user.email}</span>
              </div>
              <button
                onClick={handleLogout}
                className="w-full flex items-center justify-center space-x-2 px-4 py-2.5 rounded-lg border border-red-500/20 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all text-xs font-mono tracking-widest uppercase"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Sign Out</span>
              </button>
            </div>
          ) : (
            <>
              <button
                onClick={handleSignIn}
                className="w-full flex items-center justify-center space-x-2 px-4 py-2.5 rounded-lg border border-white/[0.08] bg-white/[0.03] text-neutral-300 hover:text-white hover:bg-white/[0.06] transition-all text-xs font-mono tracking-widest uppercase"
              >
                <LogIn className="w-3.5 h-3.5" />
                <span>Sign In</span>
              </button>

              <button
                onClick={handleGetStarted}
                className="w-full flex items-center justify-center space-x-2 px-4 py-2.5 rounded-lg bg-[#2ee6ca] hover:bg-[#28d1b7] text-black font-mono text-xs uppercase tracking-widest font-semibold transition-all shadow-[0_0_25px_rgba(46,230,202,0.2)]"
              >
                <span>Get Started</span>
                <Rocket className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
