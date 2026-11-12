import React, { useEffect, useRef, useCallback } from 'react';
import { X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import LoginForm from './LoginForm';
import SignupForm from './SignupForm';

export default function AuthModal() {
  const { modalState, closeModal } = useAuth();
  const overlayRef = useRef(null);
  const panelRef = useRef(null);
  const previousFocusRef = useRef(null);

  const isOpen = modalState !== null;

  /* ── Lock body scroll ───────────────────────── */
  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement;
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
      previousFocusRef.current?.focus?.();
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  /* ── Escape key ─────────────────────────────── */
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => {
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, closeModal]);

  /* ── Focus trap ─────────────────────────────── */
  useEffect(() => {
    if (!isOpen || !panelRef.current) return;
    const panel = panelRef.current;
    const focusable = panel.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length) focusable[0].focus();

    const trapFocus = (e) => {
      if (e.key !== 'Tab' || !focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', trapFocus);
    return () => window.removeEventListener('keydown', trapFocus);
  }, [isOpen, modalState]);

  /* ── Click outside ──────────────────────────── */
  const handleOverlayClick = useCallback(
    (e) => {
      if (e.target === overlayRef.current) closeModal();
    },
    [closeModal]
  );

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={modalState === 'login' ? 'Sign in to ParkX' : 'Create a ParkX account'}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-fadeIn"
    >
      {/* ── Backdrop ──────────────────────────── */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-md" />

      {/* ── Modal Panel ───────────────────────── */}
      <div
        ref={panelRef}
        className="relative w-full max-w-md bg-[#0d0d0d]/95 border border-white/[0.08] rounded-2xl shadow-2xl shadow-black/60 backdrop-blur-xl overflow-hidden animate-modalIn"
      >
        {/* Accent glow line */}
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[#2ee6ca]/40 to-transparent" />

        {/* Close button */}
        <button
          onClick={closeModal}
          className="absolute top-4 right-4 z-10 p-2 rounded-lg bg-white/[0.04] border border-white/[0.06] text-neutral-400 hover:text-white hover:bg-white/[0.08] transition-all duration-200"
          aria-label="Close dialog"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Top brand marker */}
        <div className="flex justify-center pt-8 pb-2">
          <div className="w-10 h-10 rounded-lg border border-white/10 bg-white/[0.03] flex items-center justify-center">
            <span className="font-mono text-sm font-bold tracking-widest text-[#2ee6ca]">PX</span>
          </div>
        </div>

        {/* Form area */}
        <div className="px-8 pb-10 pt-2">
          {modalState === 'login' ? <LoginForm /> : <SignupForm />}
        </div>
      </div>
    </div>
  );
}
