import React from 'react';
import { ArrowUp, Mail, ExternalLink } from 'lucide-react';

export default function Footer() {
  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const scrollTo = (id) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <footer className="relative w-full bg-[#070707] text-white border-t border-white/[0.08] pt-20 pb-12 px-6 md:px-12">
      <div className="max-w-7xl mx-auto">
        
        {/* Top Branding & Statement */}
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-8 pb-16 border-b border-white/[0.08]">
          <div className="space-y-3 max-w-md">
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 rounded border border-white/20 bg-white/[0.03] flex items-center justify-center">
                <span className="font-mono text-xs font-bold tracking-widest text-[#2ee6ca]">PX</span>
              </div>
              <span className="font-display font-bold text-2xl tracking-[0.25em] text-white uppercase">
                PARK<span className="text-[#2ee6ca]">X</span>
              </span>
            </div>
            <p className="text-sm text-neutral-400 font-light leading-relaxed">
              Intelligent parking. Reimagined through cinematic autonomous trajectory control.
            </p>
          </div>

          <div className="flex items-center space-x-3 text-xs font-mono text-neutral-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span>SYSTEMS OPERATIONAL // SIMULATION READY</span>
          </div>
        </div>

        {/* Navigation Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-10 py-16 border-b border-white/[0.08]">
          
          {/* Column 1: Explore */}
          <div className="space-y-4">
            <h4 className="text-xs font-mono tracking-widest uppercase text-neutral-300">
              EXPLORE
            </h4>
            <ul className="space-y-2.5 text-xs font-mono uppercase tracking-wider text-neutral-400">
              <li>
                <button
                  onClick={() => scrollTo('experience')}
                  className="link-hover-line hover:text-white transition-colors"
                >
                  Experience
                </button>
              </li>
              <li>
                <button
                  onClick={() => scrollTo('about')}
                  className="link-hover-line hover:text-white transition-colors"
                >
                  Concept
                </button>
              </li>
              <li>
                <button
                  onClick={() => scrollTo('technology')}
                  className="link-hover-line hover:text-white transition-colors"
                >
                  Technology
                </button>
              </li>
              <li>
                <button
                  onClick={() => scrollTo('demo')}
                  className="link-hover-line hover:text-white transition-colors"
                >
                  Simulation Demo
                </button>
              </li>
            </ul>
          </div>

          {/* Column 2: Architecture */}
          <div className="space-y-4">
            <h4 className="text-xs font-mono tracking-widest uppercase text-neutral-300">
              ARCHITECTURE
            </h4>
            <ul className="space-y-2.5 text-xs font-mono uppercase tracking-wider text-neutral-400">
              <li>
                <span className="hover:text-neutral-300 transition-colors">Computer Vision</span>
              </li>
              <li>
                <span className="hover:text-neutral-300 transition-colors">Path Planning</span>
              </li>
              <li>
                <span className="hover:text-neutral-300 transition-colors">Cognitive Decision</span>
              </li>
              <li>
                <span className="hover:text-neutral-300 transition-colors">Sensor Fusion</span>
              </li>
            </ul>
          </div>

          {/* Column 3: Project */}
          <div className="space-y-4">
            <h4 className="text-xs font-mono tracking-widest uppercase text-neutral-300">
              PROJECT
            </h4>
            <ul className="space-y-2.5 text-xs font-mono uppercase tracking-wider text-neutral-400">
              <li>
                <button
                  onClick={() => scrollTo('demo')}
                  className="link-hover-line hover:text-white transition-colors"
                >
                  Simulation
                </button>
              </li>
              <li>
                <button
                  onClick={() => scrollTo('vision')}
                  className="link-hover-line hover:text-white transition-colors"
                >
                  Vision & Roadmap
                </button>
              </li>
              <li>
                <span className="text-neutral-500">Telemetry Specs</span>
              </li>
              <li>
                <span className="text-neutral-500">Research Paper (Upcoming)</span>
              </li>
            </ul>
          </div>

          {/* Column 4: Connect */}
          <div className="space-y-4">
            <h4 className="text-xs font-mono tracking-widest uppercase text-neutral-300">
              CONNECT
            </h4>
            <ul className="space-y-2.5 text-xs font-mono uppercase tracking-wider text-neutral-400">
              <li>
                <a
                  href="https://github.com"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center space-x-2 hover:text-[#2ee6ca] transition-colors"
                >
                  <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                  </svg>
                  <span>GitHub</span>
                </a>
              </li>
              <li>
                <a
                  href="https://linkedin.com"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center space-x-2 hover:text-[#2ee6ca] transition-colors"
                >
                  <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                    <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
                  </svg>
                  <span>LinkedIn</span>
                </a>
              </li>
              <li>
                <a
                  href="mailto:contact@parkx.ai"
                  className="inline-flex items-center space-x-2 hover:text-[#2ee6ca] transition-colors"
                >
                  <Mail className="w-3.5 h-3.5" />
                  <span>Email</span>
                </a>
              </li>
            </ul>
          </div>

        </div>

        {/* Bottom Bar: Copyright & Back to Top */}
        <div className="pt-10 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs font-mono text-neutral-400">
          <div>
            © 2026 PARKX. Built as an intelligent parking simulation project.
          </div>

          <button
            onClick={scrollToTop}
            className="group inline-flex items-center space-x-2 text-neutral-400 hover:text-[#2ee6ca] transition-colors"
          >
            <span>BACK TO TOP</span>
            <ArrowUp className="w-3.5 h-3.5 group-hover:-translate-y-1 transition-transform" />
          </button>
        </div>

      </div>
    </footer>
  );
}
