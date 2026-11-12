import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  AlertOctagon,
  WifiOff,
  Car,
  Palette,
  Sparkles,
  ArrowRight,
  RefreshCw,
  Home,
  CheckCircle2,
} from 'lucide-react';
import { verifyPublicToken } from '../../services/publicService';

export default function PublicVehicleView({ token, onNavigateHome }) {
  // Token-associated verification state: ensures displayed data strictly belongs to the current token prop
  const [verificationState, setVerificationState] = useState(() => ({
    token: null,
    status: 'loading', // 'loading' | 'valid' | 'revoked' | 'invalid' | 'unavailable' | 'rate_limited'
    vehicle: null,
    message: '',
  }));
  const [visitorConfirmed, setVisitorConfirmed] = useState(false);

  // Request lifecycle management refs to prevent stale asynchronous response overwrites
  const abortControllerRef = useRef(null);
  const activeTokenRef = useRef(token);
  const requestGenRef = useRef(0);

  // Synchronously compute effective view state during render:
  // If stored verification token does not match the current token prop,
  // old vehicle and status data are immediately hidden without waiting for useEffect.
  const isTokenStale = verificationState.token !== token;
  const effectiveViewState = isTokenStale
    ? (!token || typeof token !== 'string' ? 'invalid' : 'loading')
    : verificationState.status;
  const effectiveVehicle = isTokenStale ? null : verificationState.vehicle;
  const effectiveStatusMessage = isTokenStale
    ? (!token || typeof token !== 'string' ? 'No QR pass token provided in the URL.' : '')
    : verificationState.message;
  const effectiveVisitorConfirmed = isTokenStale ? false : visitorConfirmed;

  // Set Referrer-Policy to no-referrer dynamically
  useEffect(() => {
    let meta = document.querySelector('meta[name="referrer"]');
    let added = false;
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'referrer';
      meta.content = 'no-referrer';
      document.head.appendChild(meta);
      added = true;
    } else {
      meta.content = 'no-referrer';
    }

    return () => {
      if (added && meta.parentNode) {
        meta.parentNode.removeChild(meta);
      }
    };
  }, []);

  const runVerification = useCallback((currentToken) => {
    // 1. Cancel any active in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    // 2. Increment request generation identifier
    requestGenRef.current += 1;
    const currentGen = requestGenRef.current;
    activeTokenRef.current = currentToken;

    setVisitorConfirmed(false);

    if (!currentToken || typeof currentToken !== 'string') {
      setVerificationState({
        token: currentToken,
        status: 'invalid',
        vehicle: null,
        message: 'No QR pass token provided in the URL.',
      });
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    verifyPublicToken(currentToken, { signal: controller.signal })
      .then((result) => {
        // Drop response if request generation or token is outdated or aborted
        if (requestGenRef.current !== currentGen || activeTokenRef.current !== currentToken || controller.signal.aborted) {
          return;
        }

        if (result.status === 'valid') {
          setVerificationState({
            token: currentToken,
            status: 'valid',
            vehicle: result.vehicle,
            message: '',
          });
        } else if (result.status === 'revoked') {
          setVerificationState({
            token: currentToken,
            status: 'revoked',
            vehicle: null,
            message: result.message || 'This ParkX pass has been revoked by the vehicle owner and cannot be used.',
          });
        } else if (result.status === 'rate_limited') {
          setVerificationState({
            token: currentToken,
            status: 'rate_limited',
            vehicle: null,
            message: result.message || 'Too many verification attempts. Please wait a moment before trying again.',
          });
        } else if (result.status === 'unavailable') {
          setVerificationState({
            token: currentToken,
            status: 'unavailable',
            vehicle: null,
            message: result.message || 'Unable to connect to ParkX verification services. Please retry.',
          });
        } else {
          setVerificationState({
            token: currentToken,
            status: 'invalid',
            vehicle: null,
            message: result.message || 'The scanned QR pass could not be verified.',
          });
        }
      })
      .catch((err) => {
        // Drop error if aborted or generation is outdated
        if (requestGenRef.current !== currentGen || activeTokenRef.current !== currentToken || controller.signal.aborted || err?.name === 'AbortError') {
          return;
        }

        setVerificationState({
          token: currentToken,
          status: 'unavailable',
          vehicle: null,
          message: 'Unable to reach the ParkX verification network. Please check your connection.',
        });
      });
  }, []);

  // Main token observation effect
  useEffect(() => {
    runVerification(token);

    return () => {
      // Abort in-flight request and invalidate generation on unmount or before next token effect
      requestGenRef.current += 1;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [token, runVerification]);

  const handleRetry = () => {
    setVerificationState({
      token: null,
      status: 'loading',
      vehicle: null,
      message: '',
    });
    runVerification(token);
  };

  return (
    <div className="relative min-h-[calc(100vh-80px)] pt-24 pb-20 px-6 md:px-12 max-w-3xl mx-auto flex flex-col justify-center">
      {/* ────────────────────────────────────────────── */}
      {/* 1. LOADING STATE                               */}
      {/* ────────────────────────────────────────────── */}
      {effectiveViewState === 'loading' && (
        <div role="status" className="p-10 rounded-2xl border border-white/[0.08] bg-[#0c0c0c]/80 backdrop-blur-xl text-center space-y-6 animate-fadeIn">
          <div className="w-16 h-16 rounded-2xl border border-[#2ee6ca]/30 bg-[#2ee6ca]/10 flex items-center justify-center mx-auto text-[#2ee6ca]">
            <RefreshCw className="w-8 h-8 animate-spin" />
          </div>
          <div className="space-y-2">
            <span className="text-[10px] font-mono tracking-widest text-[#2ee6ca] uppercase">
              Cryptographic Telemetry Scan
            </span>
            <h2 className="font-display text-2xl md:text-3xl font-bold tracking-tight text-white uppercase">
              Verifying Vehicle Pass
            </h2>
            <p className="text-xs font-mono text-neutral-400 max-w-sm mx-auto">
              Querying the ParkX autonomous terminal network to authenticate the security token...
            </p>
          </div>
        </div>
      )}

      {/* ────────────────────────────────────────────── */}
      {/* 2. VALID QR PASS STATE                         */}
      {/* ────────────────────────────────────────────── */}
      {effectiveViewState === 'valid' && effectiveVehicle && (
        <div className="p-8 md:p-10 rounded-2xl border border-[#2ee6ca]/30 bg-[#0d0d0d]/90 backdrop-blur-xl shadow-2xl shadow-black/80 space-y-8 animate-fadeIn">
          {/* Top Verified Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-white/[0.08]">
            <div className="flex items-center space-x-3">
              <div className="w-12 h-12 rounded-xl border border-[#2ee6ca]/40 bg-[#2ee6ca]/10 flex items-center justify-center text-[#2ee6ca] shadow-[0_0_20px_rgba(46,230,202,0.2)]">
                <ShieldCheck className="w-6 h-6" />
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <span className="w-2 h-2 rounded-full bg-[#2ee6ca] animate-pulse" />
                  <span className="text-[10px] font-mono tracking-widest uppercase text-[#2ee6ca]">
                    VERIFIED PASS
                  </span>
                </div>
                <h2 className="font-display text-xl md:text-2xl font-bold tracking-tight text-white uppercase">
                  ParkX Autonomous Access
                </h2>
              </div>
            </div>

            <div className="inline-flex items-center px-3 py-1 rounded-full border border-white/10 bg-white/[0.03] text-[10px] font-mono text-neutral-300 uppercase">
              Visitor Portal
            </div>
          </div>

          {/* Minimal Vehicle Identity (Never reveals owner, phone, or plate) */}
          <div className="p-6 rounded-xl bg-[#141414] border border-white/[0.06] space-y-4">
            <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-400 flex items-center space-x-2">
              <Sparkles className="w-3.5 h-3.5 text-[#2ee6ca]" />
              <span>Target Vehicle Specifications</span>
            </span>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
              {/* Model */}
              <div className="p-4 rounded-lg bg-[#181818] border border-white/[0.04]">
                <span className="text-[10px] font-mono uppercase text-neutral-500 block mb-1">
                  Make & Model
                </span>
                <span className="font-display font-semibold text-base text-white uppercase truncate block">
                  {effectiveVehicle.vehicleModel}
                </span>
              </div>

              {/* Classification */}
              <div className="p-4 rounded-lg bg-[#181818] border border-white/[0.04]">
                <span className="text-[10px] font-mono uppercase text-neutral-500 block mb-1">
                  Classification
                </span>
                <div className="flex items-center space-x-2 text-white font-mono text-sm uppercase">
                  <Car className="w-4 h-4 text-[#2ee6ca]" />
                  <span>{effectiveVehicle.vehicleType}</span>
                </div>
              </div>

              {/* Exterior Color */}
              <div className="p-4 rounded-lg bg-[#181818] border border-white/[0.04]">
                <span className="text-[10px] font-mono uppercase text-neutral-500 block mb-1">
                  Exterior Finish
                </span>
                <div className="flex items-center space-x-2 text-white font-mono text-sm">
                  <Palette className="w-4 h-4 text-[#2ee6ca]" />
                  <span>{effectiveVehicle.color}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Action to Continue as Visitor */}
          <div className="space-y-4 pt-2">
            {!effectiveVisitorConfirmed ? (
              <button
                onClick={() => setVisitorConfirmed(true)}
                className="group w-full flex items-center justify-center space-x-2 py-4 rounded-xl bg-[#2ee6ca] hover:bg-[#28d1b7] active:bg-[#22b8a1] text-black font-mono text-xs uppercase tracking-widest font-semibold transition-all duration-300 shadow-[0_0_30px_rgba(46,230,202,0.25)] hover:shadow-[0_0_40px_rgba(46,230,202,0.35)]"
              >
                <span>Continue as Visitor</span>
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </button>
            ) : (
              <div className="p-4 rounded-xl bg-[#2ee6ca]/10 border border-[#2ee6ca]/30 text-[#2ee6ca] font-mono text-xs text-center space-y-1 animate-fadeIn">
                <div className="flex items-center justify-center space-x-2">
                  <CheckCircle2 className="w-4 h-4" />
                  <span className="font-semibold uppercase tracking-wider">
                    Visitor Session Acknowledged
                  </span>
                </div>
                <p className="text-[11px] text-neutral-300">
                  Ready for terminal trajectory. Further visitor messaging services will activate here in Phase 3.2.
                </p>
              </div>
            )}

            <p className="text-center text-[11px] font-mono text-neutral-500">
              No account, login, or personal information required to interact with this vehicle.
            </p>
          </div>
        </div>
      )}

      {/* ────────────────────────────────────────────── */}
      {/* 3. REVOKED QR PASS STATE                       */}
      {/* ────────────────────────────────────────────── */}
      {effectiveViewState === 'revoked' && (
        <div className="p-8 md:p-10 rounded-2xl border border-amber-500/30 bg-[#0d0d0d]/90 backdrop-blur-xl text-center space-y-6 shadow-2xl shadow-black/80 animate-fadeIn">
          <div className="w-16 h-16 rounded-2xl border border-amber-500/30 bg-amber-500/10 flex items-center justify-center mx-auto text-amber-400">
            <ShieldAlert className="w-8 h-8" />
          </div>

          <div className="space-y-2 max-w-md mx-auto">
            <span className="text-[10px] font-mono tracking-widest uppercase text-amber-400">
              Pass Authorization Terminated
            </span>
            <h2 className="font-display text-2xl font-bold tracking-tight text-white uppercase">
              QR Code Revoked
            </h2>
            <p className="text-xs font-mono text-neutral-300 leading-relaxed">
              {effectiveStatusMessage || 'This ParkX pass has been revoked by the vehicle owner and cannot be used.'}
            </p>
          </div>

          <div className="pt-2">
            <button
              onClick={onNavigateHome}
              className="inline-flex items-center space-x-2 px-6 py-3 rounded-lg border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.06] text-white text-xs font-mono uppercase tracking-widest transition-colors"
            >
              <Home className="w-4 h-4" />
              <span>Return to ParkX</span>
            </button>
          </div>
        </div>
      )}

      {/* ────────────────────────────────────────────── */}
      {/* 4. INVALID / MALFORMED QR PASS STATE           */}
      {effectiveViewState === 'invalid' && (
        <div className="p-8 md:p-10 rounded-2xl border border-red-500/30 bg-[#0d0d0d]/90 backdrop-blur-xl text-center space-y-6 shadow-2xl shadow-black/80 animate-fadeIn">
          <div className="w-16 h-16 rounded-2xl border border-red-500/30 bg-red-500/10 flex items-center justify-center mx-auto text-red-400">
            <AlertOctagon className="w-8 h-8" />
          </div>

          <div className="space-y-2 max-w-md mx-auto">
            <span className="text-[10px] font-mono tracking-widest uppercase text-red-400">
              Authentication Error
            </span>
            <h2 className="font-display text-2xl font-bold tracking-tight text-white uppercase">
              Invalid QR Pass
            </h2>
            <p className="text-xs font-mono text-neutral-300 leading-relaxed">
              {effectiveStatusMessage || 'The scanned QR code is malformed, expired, or not recognized by ParkX systems.'}
            </p>
          </div>

          <div className="pt-2">
            <button
              onClick={onNavigateHome}
              className="inline-flex items-center space-x-2 px-6 py-3 rounded-lg border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.06] text-white text-xs font-mono uppercase tracking-widest transition-colors"
            >
              <Home className="w-4 h-4" />
              <span>Return to ParkX</span>
            </button>
          </div>
        </div>
      )}

      {/* ────────────────────────────────────────────── */}
      {/* 5. SERVER UNAVAILABLE / RATE LIMITED STATE     */}
      {/* ────────────────────────────────────────────── */}
      {(effectiveViewState === 'unavailable' || effectiveViewState === 'rate_limited') && (
        <div className="p-8 md:p-10 rounded-2xl border border-white/[0.08] bg-[#0d0d0d]/90 backdrop-blur-xl text-center space-y-6 shadow-2xl shadow-black/80 animate-fadeIn">
          <div className="w-16 h-16 rounded-2xl border border-white/10 bg-white/[0.04] flex items-center justify-center mx-auto text-neutral-400">
            <WifiOff className="w-8 h-8" />
          </div>

          <div className="space-y-2 max-w-md mx-auto">
            <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-400">
              Network Telemetry Notice
            </span>
            <h2 className="font-display text-2xl font-bold tracking-tight text-white uppercase">
              {effectiveViewState === 'rate_limited' ? 'Too Many Requests' : 'Network Unavailable'}
            </h2>
            <p className="text-xs font-mono text-neutral-300 leading-relaxed">
              {effectiveStatusMessage || 'Unable to connect to ParkX verification services. Please retry.'}
            </p>
          </div>

          <div className="pt-2 flex items-center justify-center space-x-3">
            <button
              onClick={handleRetry}
              className="inline-flex items-center space-x-2 px-5 py-2.5 rounded-lg bg-[#2ee6ca] hover:bg-[#28d1b7] text-black text-xs font-mono uppercase font-semibold transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Retry Scan</span>
            </button>
            <button
              onClick={onNavigateHome}
              className="inline-flex items-center space-x-2 px-5 py-2.5 rounded-lg border border-white/[0.08] text-white text-xs font-mono uppercase transition-colors"
            >
              <span>Home</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
