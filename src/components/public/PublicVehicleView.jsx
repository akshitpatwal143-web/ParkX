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
  MessageSquare,
  Clock,
  Loader2,
  XCircle,
} from 'lucide-react';
import {
  verifyPublicToken,
  createVisitorSession,
  getVisitorSession,
  closeVisitorSession,
  getStoredVisitorSession,
  saveStoredVisitorSession,
  clearStoredVisitorSession,
} from '../../services/publicService';

export default function PublicVehicleView({ token, onNavigateHome }) {
  // Token-associated verification state: ensures displayed data strictly belongs to the current token prop
  const [verificationState, setVerificationState] = useState(() => ({
    token: null,
    status: 'loading', // 'loading' | 'valid' | 'revoked' | 'invalid' | 'unavailable' | 'rate_limited'
    vehicle: null,
    message: '',
  }));
  const [visitorConfirmed, setVisitorConfirmed] = useState(false);

  // Visitor contact session state
  const [visitorSession, setVisitorSession] = useState(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState('');

  // Request lifecycle management refs to prevent stale asynchronous response overwrites
  const abortControllerRef = useRef(null);
  const activeTokenRef = useRef(token);
  const requestGenRef = useRef(0);
  const pollingAbortRef = useRef(null);
  const pollingGenRef = useRef(0);

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
  const effectiveVisitorSession = isTokenStale ? null : visitorSession;

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
    // 1. Cancel any active in-flight requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (pollingAbortRef.current) {
      pollingAbortRef.current.abort();
      pollingAbortRef.current = null;
    }

    // 2. Increment request generation identifiers
    requestGenRef.current += 1;
    pollingGenRef.current += 1;
    const currentGen = requestGenRef.current;
    activeTokenRef.current = currentToken;

    setVisitorConfirmed(false);
    setVisitorSession(null);
    setSessionError('');

    if (!currentToken || typeof currentToken !== 'string') {
      setVerificationState({
        token: currentToken,
        status: 'invalid',
        vehicle: null,
        message: 'No QR pass token provided in the URL.',
      });
      return;
    }

    // Check stored session in sessionStorage for this token
    const stored = getStoredVisitorSession(currentToken);
    if (stored?.sessionId && stored?.visitorCredential) {
      setVisitorSession(stored);
      setVisitorConfirmed(true);
      // Background refresh session status with generation and target guards
      const sessionPromise = getVisitorSession(stored.sessionId, stored.visitorCredential);
      if (sessionPromise && typeof sessionPromise.then === 'function') {
        sessionPromise
          .then((fresh) => {
            if (requestGenRef.current !== currentGen || activeTokenRef.current !== currentToken) {
              return;
            }
            if (fresh && fresh.status && fresh.status !== 'unavailable') {
              setVisitorSession((prev) => {
                if (!prev || prev.sessionId !== stored.sessionId || prev.status === 'closed') {
                  return prev;
                }
                return { ...prev, ...fresh };
              });
            }
          })
          .catch(() => {});
      }
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
      requestGenRef.current += 1;
      pollingGenRef.current += 1;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      if (pollingAbortRef.current) {
        pollingAbortRef.current.abort();
        pollingAbortRef.current = null;
      }
    };
  }, [token, runVerification]);

  // Periodic polling while visitor session is pending owner acceptance
  // Uses generation guard and AbortController to prevent stale responses from overwriting newer state
  useEffect(() => {
    if (!visitorSession?.sessionId || !visitorSession?.visitorCredential || visitorSession.status !== 'pending') {
      if (pollingAbortRef.current) {
        pollingAbortRef.current.abort();
        pollingAbortRef.current = null;
      }
      return;
    }

    const targetSessionId = visitorSession.sessionId;
    const targetCredential = visitorSession.visitorCredential;

    const interval = setInterval(async () => {
      // Abort previous in-flight polling request before initiating next
      if (pollingAbortRef.current) {
        pollingAbortRef.current.abort();
      }

      const controller = new AbortController();
      pollingAbortRef.current = controller;
      pollingGenRef.current += 1;
      const thisGen = pollingGenRef.current;

      try {
        const fresh = await getVisitorSession(targetSessionId, targetCredential, { signal: controller.signal });
        // Drop response if controller was aborted or a newer poll generation occurred
        if (controller.signal.aborted || pollingGenRef.current !== thisGen) {
          return;
        }

        if (fresh?.status && fresh.status !== 'unavailable') {
          setVisitorSession((prev) => {
            // Guard against overwriting if session was closed, expired, or replaced in the meantime
            if (!prev || prev.sessionId !== targetSessionId || prev.status === 'closed') {
              return prev;
            }
            return { ...prev, ...fresh };
          });
        }
      } catch {
        // Silently catch aborts and network blips during polling
      }
    }, 8000);

    return () => {
      clearInterval(interval);
      if (pollingAbortRef.current) {
        pollingAbortRef.current.abort();
        pollingAbortRef.current = null;
      }
    };
  }, [visitorSession?.sessionId, visitorSession?.visitorCredential, visitorSession?.status]);

  const handleRetry = () => {
    setVerificationState({
      token: null,
      status: 'loading',
      vehicle: null,
      message: '',
    });
    runVerification(token);
  };

  const handleContactOwner = async () => {
    if (!token || sessionLoading) return;
    setSessionLoading(true);
    setSessionError('');

    // Cancel active polling before creating a new session
    if (pollingAbortRef.current) {
      pollingAbortRef.current.abort();
      pollingAbortRef.current = null;
    }
    pollingGenRef.current += 1;

    try {
      const res = await createVisitorSession(token);
      if (res.status === 'pending') {
        setVisitorSession(res);
        setVisitorConfirmed(true);
      } else {
        setSessionError(res.message || 'Failed to create contact session.');
      }
    } catch (err) {
      setSessionError('Network error while initiating contact session. Please retry.');
    } finally {
      setSessionLoading(false);
    }
  };

  const handleCloseSession = async () => {
    if (!visitorSession?.sessionId || !visitorSession?.visitorCredential) return;
    setSessionLoading(true);

    // Cancel any in-flight polling request immediately upon closing
    if (pollingAbortRef.current) {
      pollingAbortRef.current.abort();
      pollingAbortRef.current = null;
    }
    pollingGenRef.current += 1;

    try {
      const res = await closeVisitorSession(visitorSession.sessionId, visitorSession.visitorCredential);
      if (res.status === 'closed') {
        setVisitorSession((prev) => (prev ? { ...prev, status: 'closed', closedAt: res.closedAt } : prev));
        clearStoredVisitorSession(token);
      } else {
        setSessionError(res.message || 'Unable to close session.');
      }
    } catch (err) {
      setSessionError('Network error while closing session.');
    } finally {
      setSessionLoading(false);
    }
  };

  return (
    <div className="relative min-h-[calc(100vh-80px)] pt-24 pb-20 px-6 md:px-12 max-w-2xl mx-auto flex flex-col justify-center">
      {/* ────────────────────────────────────────────── */}
      {/* 1. LOADING / VERIFYING STATE                   */}
      {/* ────────────────────────────────────────────── */}
      {effectiveViewState === 'loading' && (
        <div role="status" className="p-8 md:p-12 rounded-2xl border border-white/[0.08] bg-[#0d0d0d]/80 backdrop-blur-xl text-center space-y-6 shadow-2xl shadow-black/80 animate-fadeIn">
          <div className="relative w-16 h-16 mx-auto flex items-center justify-center">
            <div className="absolute inset-0 rounded-2xl border border-[#2ee6ca]/20 animate-ping opacity-25" />
            <div className="w-16 h-16 rounded-2xl border border-[#2ee6ca]/30 bg-[#2ee6ca]/10 flex items-center justify-center text-[#2ee6ca]">
              <RefreshCw className="w-8 h-8 animate-spin" />
            </div>
          </div>

          <div className="space-y-2">
            <span className="text-[10px] font-mono tracking-widest uppercase text-[#2ee6ca] block">
              Cryptographic Pass Verification
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
                  Make &amp; Model
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

          {/* Phase 3.2: Anonymous Visitor Contact Section */}
          <div className="space-y-4 pt-2">
            {sessionError && (
              <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-mono">
                {sessionError}
              </div>
            )}

            {!effectiveVisitorSession ? (
              <button
                onClick={handleContactOwner}
                disabled={sessionLoading}
                className="group w-full flex items-center justify-center space-x-2 py-4 rounded-xl bg-[#2ee6ca] hover:bg-[#28d1b7] active:bg-[#22b8a1] text-black font-mono text-xs uppercase tracking-widest font-semibold transition-all duration-300 shadow-[0_0_30px_rgba(46,230,202,0.25)] hover:shadow-[0_0_40px_rgba(46,230,202,0.35)] disabled:opacity-50"
              >
                {sessionLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Initiating Contact Session...</span>
                  </>
                ) : (
                  <>
                    <MessageSquare className="w-4 h-4" />
                    <span>Contact Vehicle Owner</span>
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                  </>
                )}
              </button>
            ) : (
              <div className="p-5 rounded-xl bg-[#141414] border border-[#2ee6ca]/30 space-y-4 animate-fadeIn">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-white/[0.06]">
                  <div className="flex items-center space-x-2">
                    <span
                      className={`w-2.5 h-2.5 rounded-full ${
                        effectiveVisitorSession.status === 'pending'
                          ? 'bg-amber-400 animate-pulse'
                          : effectiveVisitorSession.status === 'accepted'
                          ? 'bg-[#2ee6ca] animate-pulse'
                          : 'bg-neutral-500'
                      }`}
                    />
                    <span className="font-mono text-xs uppercase tracking-wider text-white font-semibold">
                      {effectiveVisitorSession.status === 'pending' && 'Contact Request Pending'}
                      {effectiveVisitorSession.status === 'accepted' && 'Contact Request Accepted'}
                      {effectiveVisitorSession.status === 'closed' && 'Contact Session Closed'}
                      {effectiveVisitorSession.status === 'expired' && 'Contact Session Expired'}
                    </span>
                  </div>

                  <span className="text-[10px] font-mono text-neutral-400">
                    Session: {effectiveVisitorSession.sessionId?.slice(0, 16)}...
                  </span>
                </div>

                <div className="text-xs font-mono text-neutral-300 space-y-2 leading-relaxed">
                  {effectiveVisitorSession.status === 'pending' && (
                    <p>
                      Your contact notification has been dispatched to the vehicle owner. Waiting for owner acknowledgment...
                    </p>
                  )}
                  {effectiveVisitorSession.status === 'accepted' && (
                    <p className="text-[#2ee6ca]">
                      The vehicle owner has accepted your contact request. Active temporary contact channel is open.
                    </p>
                  )}
                  {effectiveVisitorSession.status === 'closed' && (
                    <p className="text-neutral-400">
                      This contact session has concluded.
                    </p>
                  )}
                  {effectiveVisitorSession.status === 'expired' && (
                    <p className="text-amber-400/80">
                      This contact session has expired.
                    </p>
                  )}
                </div>

                {effectiveVisitorSession.expiresAt && (
                  <div className="flex items-center space-x-1.5 text-[10px] font-mono text-neutral-500 pt-1">
                    <Clock className="w-3.5 h-3.5" />
                    <span>Expires: {new Date(effectiveVisitorSession.expiresAt).toLocaleTimeString()}</span>
                  </div>
                )}

                {(effectiveVisitorSession.status === 'pending' || effectiveVisitorSession.status === 'accepted') && (
                  <button
                    onClick={handleCloseSession}
                    disabled={sessionLoading}
                    className="w-full inline-flex items-center justify-center space-x-1.5 py-2.5 rounded-lg border border-red-500/20 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-mono uppercase tracking-wider transition-colors disabled:opacity-50"
                  >
                    {sessionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                    <span>Close Contact Session</span>
                  </button>
                )}
              </div>
            )}

            <p className="text-center text-[11px] font-mono text-neutral-500">
              No account, login, or personal phone number required. The owner never sees your identity.
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

          <div className="pt-4 border-t border-white/[0.06] flex justify-center">
            <button
              onClick={onNavigateHome}
              className="inline-flex items-center space-x-2 px-5 py-2.5 rounded-lg border border-white/[0.08] bg-white/[0.02] text-neutral-300 hover:text-white hover:bg-white/[0.06] font-mono text-xs uppercase tracking-widest transition-colors"
            >
              <Home className="w-3.5 h-3.5" />
              <span>Return Home</span>
            </button>
          </div>
        </div>
      )}

      {/* ────────────────────────────────────────────── */}
      {/* 4. INVALID QR PASS STATE                       */}
      {/* ────────────────────────────────────────────── */}
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
              {effectiveStatusMessage || 'The scanned QR pass could not be verified or does not exist.'}
            </p>
          </div>

          <div className="pt-4 border-t border-white/[0.06] flex justify-center">
            <button
              onClick={onNavigateHome}
              className="inline-flex items-center space-x-2 px-5 py-2.5 rounded-lg border border-white/[0.08] bg-white/[0.02] text-neutral-300 hover:text-white hover:bg-white/[0.06] font-mono text-xs uppercase tracking-widest transition-colors"
            >
              <Home className="w-3.5 h-3.5" />
              <span>Return Home</span>
            </button>
          </div>
        </div>
      )}

      {/* ────────────────────────────────────────────── */}
      {/* 5. RATE LIMITED STATE                          */}
      {/* ────────────────────────────────────────────── */}
      {effectiveViewState === 'rate_limited' && (
        <div className="p-8 md:p-10 rounded-2xl border border-amber-500/30 bg-[#0d0d0d]/90 backdrop-blur-xl text-center space-y-6 shadow-2xl shadow-black/80 animate-fadeIn">
          <div className="w-16 h-16 rounded-2xl border border-amber-500/30 bg-amber-500/10 flex items-center justify-center mx-auto text-amber-400">
            <Clock className="w-8 h-8" />
          </div>

          <div className="space-y-2 max-w-md mx-auto">
            <span className="text-[10px] font-mono tracking-widest uppercase text-amber-400">
              Security Rate Limit Triggered
            </span>
            <h2 className="font-display text-2xl font-bold tracking-tight text-white uppercase">
              Too Many Attempts
            </h2>
            <p className="text-xs font-mono text-neutral-300 leading-relaxed">
              {effectiveStatusMessage || 'Too many verification attempts detected from your network. Please wait a moment before trying again.'}
            </p>
          </div>

          <div className="pt-4 border-t border-white/[0.06] flex justify-center">
            <button
              onClick={handleRetry}
              className="inline-flex items-center space-x-2 px-5 py-2.5 rounded-lg border border-[#2ee6ca]/40 bg-[#2ee6ca]/10 text-[#2ee6ca] hover:bg-[#2ee6ca]/20 font-mono text-xs uppercase tracking-widest transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Retry Verification</span>
            </button>
          </div>
        </div>
      )}

      {/* ────────────────────────────────────────────── */}
      {/* 6. UNAVAILABLE / OFFLINE STATE                 */}
      {/* ────────────────────────────────────────────── */}
      {effectiveViewState === 'unavailable' && (
        <div className="p-8 md:p-10 rounded-2xl border border-white/[0.1] bg-[#0d0d0d]/90 backdrop-blur-xl text-center space-y-6 shadow-2xl shadow-black/80 animate-fadeIn">
          <div className="w-16 h-16 rounded-2xl border border-white/[0.1] bg-white/[0.02] flex items-center justify-center mx-auto text-neutral-400">
            <WifiOff className="w-8 h-8" />
          </div>

          <div className="space-y-2 max-w-md mx-auto">
            <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-400">
              Network Status Offline
            </span>
            <h2 className="font-display text-2xl font-bold tracking-tight text-white uppercase">
              Service Unavailable
            </h2>
            <p className="text-xs font-mono text-neutral-300 leading-relaxed">
              {effectiveStatusMessage || 'Unable to establish a secure link to the ParkX autonomous network. Check your connection.'}
            </p>
          </div>

          <div className="pt-4 border-t border-white/[0.06] flex items-center justify-center space-x-4">
            <button
              onClick={handleRetry}
              className="inline-flex items-center space-x-2 px-5 py-2.5 rounded-lg border border-[#2ee6ca]/40 bg-[#2ee6ca]/10 text-[#2ee6ca] hover:bg-[#2ee6ca]/20 font-mono text-xs uppercase tracking-widest transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Retry Connection</span>
            </button>
            <button
              onClick={onNavigateHome}
              className="inline-flex items-center space-x-2 px-5 py-2.5 rounded-lg border border-white/[0.08] bg-white/[0.02] text-neutral-400 hover:text-white font-mono text-xs uppercase tracking-widest transition-colors"
            >
              <Home className="w-3.5 h-3.5" />
              <span>Home</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
