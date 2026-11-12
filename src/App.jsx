import React, { useRef, useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import Navbar from './components/Navbar';
import AuthModal from './components/auth/AuthModal';
import FrameCanvas from './components/FrameCanvas';
import Hero from './components/Hero';
import Footer from './components/Footer';
import Vehicles from './components/vehicles/Vehicles';
import PublicVehicleView from './components/public/PublicVehicleView';
import { AUTH_UNAVAILABLE_MESSAGE, getAuthStatus } from './context/authStatus';

import FrameLoader from './animation/FrameLoader';
import ScrollController from './animation/ScrollController';
import { frameRenderer } from './animation/FrameRenderer';

const GOOGLE_FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@300;400;500;600;700&display=swap';

export function isVisitorPath(pathname = '') {
  return /^\/v(\/.*)?$/i.test(pathname);
}

export function extractVisitorToken(pathname = '') {
  if (!isVisitorPath(pathname)) return '';
  const segment = pathname.replace(/^\/v\/?/i, '').split('/')[0] || '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function syncThirdPartyFontPolicy(pathname = window.location.pathname) {
  const existingFontLink = document.querySelector('link[href*="fonts.googleapis.com"]');
  if (isVisitorPath(pathname)) {
    if (existingFontLink && existingFontLink.parentNode) {
      existingFontLink.parentNode.removeChild(existingFontLink);
    }
  } else {
    if (!existingFontLink && typeof document !== 'undefined' && document.head) {
      const fonts = document.createElement('link');
      fonts.rel = 'stylesheet';
      fonts.href = GOOGLE_FONTS_HREF;
      document.head.appendChild(fonts);
    }
  }
}

function AuthFeedback() {
  const { authError, isInitializing } = useAuth();
  if (getAuthStatus(isInitializing, authError) !== 'unavailable') return null;
  return (
    <div role="status" className="fixed top-20 right-4 z-[60] max-w-sm rounded-lg border border-amber-400/30 bg-[#101010]/95 px-4 py-3 text-xs font-mono text-amber-200 shadow-xl">
      {AUTH_UNAVAILABLE_MESSAGE}
    </div>
  );
}

function MainLayout() {
  const scrollTrackRef = useRef(null);
  const canvasRef = useRef(null);

  const [renderedFrame, setRenderedFrame] = useState(0);
  const [scrollProgress, setScrollProgress] = useState(0);

  // View state: 'landing' | 'garage' | 'visitor'
  const [currentView, setCurrentView] = useState(() => {
    if (window.location.pathname.startsWith('/vehicles')) return 'garage';
    if (isVisitorPath(window.location.pathname)) return 'visitor';
    return 'landing';
  });

  const [publicToken, setPublicToken] = useState(() => {
    return extractVisitorToken(window.location.pathname);
  });

  const { user, openLogin, isInitializing } = useAuth();

  // Sync font policy on initial mount and route changes
  useEffect(() => {
    syncThirdPartyFontPolicy(window.location.pathname);
  }, [currentView]);

  // Sync browser back/forward buttons
  useEffect(() => {
    const handlePopState = () => {
      const path = window.location.pathname;
      syncThirdPartyFontPolicy(path);

      if (path.startsWith('/vehicles')) {
        setCurrentView('garage');
      } else if (isVisitorPath(path)) {
        setPublicToken(extractVisitorToken(path));
        setCurrentView('visitor');
      } else {
        setCurrentView('landing');
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const handleNavigateView = (view) => {
    if (view === 'garage') {
      if (!user && !isInitializing) {
        openLogin();
        return;
      }
      window.history.pushState({}, '', '/vehicles');
      syncThirdPartyFontPolicy('/vehicles');
      setCurrentView('garage');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      window.history.pushState({}, '', '/');
      syncThirdPartyFontPolicy('/');
      setCurrentView('landing');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  // Protect garage route if session expires or user logs out while in garage
  useEffect(() => {
    if (!isInitializing && !user && currentView === 'garage') {
      setCurrentView('landing');
      window.history.replaceState({}, '', '/');
    }
  }, [user, isInitializing, currentView]);

  useEffect(() => {
    // 1. Initialize Progressive FrameLoader with updated frame sequence
    const loader = new FrameLoader({
      totalFrames: 150,
      framePathPattern: (i) => `/frames/frame-${String(i + 1).padStart(3, '0')}.jpg?v=2`,
      onProgress: () => {
        if (canvasRef.current) {
          frameRenderer.render(canvasRef.current, 0);
        }
      },
      onStatusChange: () => {
        if (canvasRef.current) {
          frameRenderer.render(canvasRef.current, 0);
        }
      },
    });

    loader.start();

    // 2. Initialize ScrollController over the pure cinematic scroll track
    if (scrollTrackRef.current) {
      const controller = new ScrollController({
        containerRef: scrollTrackRef.current,
        totalFrames: 150,
        lerpFactor: 0.18,
        onFrameUpdate: (frame, progress) => {
          setRenderedFrame(frame);
          setScrollProgress(progress);
        },
      });

      controller.attach();

      return () => {
        controller.detach();
      };
    }
  }, [currentView]);

  return (
    <div className="min-h-screen bg-[#080808] text-white selection:bg-[#2ee6ca] selection:text-black">
      <AuthFeedback />
      
      {/* PERSISTENT FULLSCREEN CANVAS ENGINE (Active on landing, persistent background) */}
      <div
        className={`fixed inset-0 z-0 pointer-events-none w-screen h-screen overflow-hidden transition-opacity duration-700 ${
          currentView === 'landing' ? 'opacity-100' : 'opacity-10'
        }`}
      >
        <FrameCanvas ref={canvasRef} currentFrame={renderedFrame} />
      </div>

      {/* Minimal Fixed Luxury Navbar with View Switcher */}
      <Navbar currentView={currentView} onNavigateView={handleNavigateView} />

      {/* Authentication Modal Overlay */}
      <AuthModal />

      {/* MAIN CONTENT AREA */}
      {currentView === 'visitor' ? (
        /* PUBLIC VISITOR VERIFICATION MODULE */
        <main className="relative z-10 min-h-screen bg-[#080808]/95">
          <PublicVehicleView
            key={publicToken || 'empty'}
            token={publicToken}
            onNavigateHome={() => handleNavigateView('landing')}
          />
          <div className="relative z-20 bg-[#080808] border-t border-white/[0.08]">
            <Footer />
          </div>
        </main>
      ) : currentView === 'garage' ? (
        /* PROTECTED VEHICLES MODULE */
        <main className="relative z-10 min-h-screen bg-[#080808]/90">
          {isInitializing ? (
            <div role="status" className="min-h-[70vh] flex items-center justify-center text-xs font-mono tracking-widest uppercase text-neutral-400">Restoring secure session...</div>
          ) : user ? (
            <><Vehicles /><div className="relative z-20 bg-[#080808] border-t border-white/[0.08]"><Footer /></div></>
          ) : null}
        </main>
      ) : (
        /* PURE CINEMATIC SCROLL CONTAINER */
        <main className="relative z-10">
          <div ref={scrollTrackRef} className="relative" style={{ height: '480vh' }}>

            {/* ONLY OVERLAY: HERO SECTION (THE FUTURE OF PARKING) */}
            <div className="relative min-h-screen flex flex-col justify-center">
              <Hero onExploreClick={() => {
                window.scrollBy({ top: window.innerHeight * 0.9, behavior: 'smooth' });
              }} />
            </div>

            {/* After Hero: ZERO OVERLAYS TILL LAST FRAME OF CAR.
                The remaining ~320vh is 100% unobstructed, pure cinematic car movement. */}
          </div>

          {/* FOOTER AT LAST FRAME OF CAR */}
          <div className="relative z-20 bg-[#080808] border-t border-white/[0.08]">
            <Footer />
          </div>
        </main>
      )}

    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <MainLayout />
    </AuthProvider>
  );
}
