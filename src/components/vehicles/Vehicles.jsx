import React, { useState, useEffect } from 'react';
import {
  Car,
  Plus,
  QrCode,
  Shield,
  Palette,
  ArrowRight,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  MessageSquare,
  Clock,
  CheckCircle,
  XCircle,
} from 'lucide-react';
import {
  fetchVehicles,
  fetchOwnerSessions,
  acceptVisitorSession,
  closeOwnerVisitorSession,
} from '../../services/vehicleService';
import AddVehicle from './AddVehicle';
import VehicleDetails from './VehicleDetails';

export default function Vehicles() {
  const [vehicles, setVehicles] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('vehicles'); // 'vehicles' | 'requests'
  const [actionLoadingId, setActionLoadingId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');

  // View state: 'list' | 'add' | 'details'
  const [currentView, setCurrentView] = useState('list');
  const [selectedVehicleId, setSelectedVehicleId] = useState(null);
  const [pendingQrToken, setPendingQrToken] = useState(null);

  const loadVehicles = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchVehicles();
      setVehicles(data.vehicles || []);
    } catch (err) {
      setError(err.message || 'Failed to load vehicles');
    } finally {
      setLoading(false);
    }
  };

  const loadSessions = async () => {
    setSessionsLoading(true);
    try {
      const data = await fetchOwnerSessions();
      setSessions(data.sessions || []);
    } catch {}
    finally {
      setSessionsLoading(false);
    }
  };

  useEffect(() => {
    loadVehicles();
    loadSessions();
  }, []);

  const handleAcceptSession = async (sessionId) => {
    setActionLoadingId(sessionId);
    try {
      const res = await acceptVisitorSession(sessionId);
      if (res.status === 'accepted') {
        setSessions((prev) =>
          prev.map((s) => (s.sessionId === sessionId ? { ...s, status: 'accepted', acceptedAt: res.acceptedAt } : s))
        );
      }
    } catch (err) {
      setError(err.message || 'Failed to accept session');
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleCloseSession = async (sessionId) => {
    setActionLoadingId(sessionId);
    try {
      const res = await closeOwnerVisitorSession(sessionId);
      if (res.status === 'closed') {
        setSessions((prev) =>
          prev.map((s) => (s.sessionId === sessionId ? { ...s, status: 'closed', closedAt: res.closedAt } : s))
        );
      }
    } catch (err) {
      setError(err.message || 'Failed to close session');
    } finally {
      setActionLoadingId(null);
    }
  };

  const pendingRequestsCount = sessions.filter((s) => s.status === 'pending').length;

  const handleVehicleCreated = (newVehicle) => {
    const { token, ...qrMetadata } = newVehicle.qrCode || {};
    const safeVehicle = { ...newVehicle, qrCode: newVehicle.qrCode ? qrMetadata : undefined };
    setVehicles((prev) => [safeVehicle, ...prev]);
    setPendingQrToken(token || null);
    setSelectedVehicleId(newVehicle.id);
    setCurrentView('details');
  };

  const handleVehicleDeleted = (deletedId) => {
    setVehicles((prev) => prev.filter((v) => v.id !== deletedId));
    setSelectedVehicleId(null);
    setCurrentView('list');
  };

  const handleVehicleUpdated = (updated) => {
    setVehicles((prev) => prev.map((v) => (v.id === updated.id ? updated : v)));
  };

  // Filter vehicles
  const filteredVehicles = vehicles.filter((v) => {
    const term = searchTerm.toLowerCase();
    return (
      v.registrationNumber.toLowerCase().includes(term) ||
      v.vehicleModel.toLowerCase().includes(term) ||
      v.vehicleType.toLowerCase().includes(term) ||
      (v.color && v.color.toLowerCase().includes(term))
    );
  });

  return (
    <div className="relative min-h-[calc(100vh-80px)] pt-24 pb-20 px-6 md:px-12 max-w-7xl mx-auto">
      {/* ────────────────────────────────────────────── */}
      {/* VIEW: ADD VEHICLE                              */}
      {/* ────────────────────────────────────────────── */}
      {currentView === 'add' && (
        <AddVehicle
          onVehicleCreated={handleVehicleCreated}
          onCancel={() => setCurrentView('list')}
        />
      )}

      {/* ────────────────────────────────────────────── */}
      {/* VIEW: VEHICLE DETAILS                          */}
      {/* ────────────────────────────────────────────── */}
      {currentView === 'details' && selectedVehicleId && (
        <VehicleDetails
          key={selectedVehicleId}
          vehicleId={selectedVehicleId}
          initialQrToken={pendingQrToken}
          onInitialQrTokenConsumed={() => setPendingQrToken(null)}
          onBack={() => {
            setCurrentView('list');
            setSelectedVehicleId(null);
            setPendingQrToken(null);
            loadVehicles();
          }}
          onVehicleDeleted={handleVehicleDeleted}
          onVehicleUpdated={handleVehicleUpdated}
        />
      )}

      {/* ────────────────────────────────────────────── */}
      {/* VIEW: VEHICLES LIST (GARAGE DASHBOARD)         */}
      {/* ────────────────────────────────────────────── */}
      {currentView === 'list' && (
        <div className="space-y-8 animate-fadeIn">
          {/* Header & Stats Banner */}
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-white/[0.08]">
            <div className="space-y-2">
              <div className="inline-flex items-center space-x-2 px-3 py-1 rounded-full bg-[#2ee6ca]/10 border border-[#2ee6ca]/30 text-[#2ee6ca] text-[11px] font-mono tracking-widest uppercase">
                <Sparkles className="w-3 h-3" />
                <span>Autonomous Fleet Management</span>
              </div>
              <h1 className="font-display text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight text-white uppercase">
                My Garage
              </h1>
              <p className="text-xs sm:text-sm font-mono text-neutral-400">
                Manage registered vehicles, verify cryptographic passes, and monitor telemetry.
              </p>
            </div>

            {/* Actions */}
            <div className="flex items-center space-x-3">
              <button
                onClick={() => {
                  loadVehicles();
                  loadSessions();
                }}
                disabled={loading || sessionsLoading}
                title="Refresh garage data"
                className="p-3 rounded-lg border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.06] text-neutral-300 hover:text-white transition-colors"
              >
                <RefreshCw className={`w-4 h-4 ${loading || sessionsLoading ? 'animate-spin' : ''}`} />
              </button>

              <button
                onClick={() => setCurrentView('add')}
                className="inline-flex items-center space-x-2 px-5 py-3 rounded-lg bg-[#2ee6ca] hover:bg-[#28d1b7] text-black font-mono text-xs uppercase tracking-widest font-semibold transition-all shadow-[0_0_25px_rgba(46,230,202,0.25)] hover:shadow-[0_0_35px_rgba(46,230,202,0.35)]"
              >
                <Plus className="w-4 h-4" />
                <span>Register Vehicle</span>
              </button>
            </div>
          </div>

          {/* Navigation Tabs: Fleet vs Incoming Requests */}
          <div className="flex items-center space-x-3 border-b border-white/[0.08] pb-2">
            <button
              onClick={() => setActiveTab('vehicles')}
              className={`inline-flex items-center space-x-2 px-4 py-2 rounded-lg text-xs font-mono uppercase tracking-wider transition-colors ${
                activeTab === 'vehicles'
                  ? 'bg-[#2ee6ca]/10 text-[#2ee6ca] border border-[#2ee6ca]/30 font-semibold'
                  : 'text-neutral-400 hover:text-white border border-transparent'
              }`}
            >
              <Car className="w-3.5 h-3.5" />
              <span>Registered Fleet ({vehicles.length})</span>
            </button>

            <button
              onClick={() => {
                setActiveTab('requests');
                loadSessions();
              }}
              className={`inline-flex items-center space-x-2 px-4 py-2 rounded-lg text-xs font-mono uppercase tracking-wider transition-colors ${
                activeTab === 'requests'
                  ? 'bg-[#2ee6ca]/10 text-[#2ee6ca] border border-[#2ee6ca]/30 font-semibold'
                  : 'text-neutral-400 hover:text-white border border-transparent'
              }`}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              <span>Contact Requests</span>
              {pendingRequestsCount > 0 && (
                <span className="ml-1 px-1.5 py-0.2 rounded-full bg-amber-400 text-black text-[10px] font-bold animate-pulse">
                  {pendingRequestsCount}
                </span>
              )}
            </button>
          </div>

          {/* TAB 1: REGISTERED VEHICLES */}
          {activeTab === 'vehicles' && (
            <div className="space-y-6">
              {/* Quick Stats & Search Bar */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="flex items-center space-x-4 text-xs font-mono text-neutral-400">
                  <span className="flex items-center space-x-1.5">
                    <strong className="text-[#2ee6ca] font-bold text-sm">{vehicles.length}</strong>
                    <span>Vehicle{vehicles.length === 1 ? '' : 's'} Registered</span>
                  </span>
                  <span className="text-neutral-600">•</span>
                  <span className="flex items-center space-x-1.5 text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span>Security Shield Active</span>
                  </span>
                </div>

                {/* Search Input */}
                {vehicles.length > 0 && (
                  <div className="relative w-full sm:w-64">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-neutral-500" />
                    <input
                      type="text"
                      placeholder="Filter by plate or model..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="w-full bg-[#121212] border border-white/[0.08] rounded-lg pl-9 pr-3 py-2 text-xs font-mono text-white placeholder-neutral-500 focus:border-[#2ee6ca]/50 outline-none"
                    />
                  </div>
                )}
              </div>

              {/* Error Banner */}
              {error && (
                <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-mono">
                  {error}
                </div>
              )}

              {/* Loading State */}
              {loading && vehicles.length === 0 && (
                <div className="py-24 flex flex-col items-center justify-center space-y-3">
                  <Loader2 className="w-8 h-8 text-[#2ee6ca] animate-spin" />
                  <span className="text-xs font-mono tracking-widest uppercase text-neutral-400">
                    Querying Autonomous Garage Fleet...
                  </span>
                </div>
              )}

              {/* Empty State */}
              {!loading && vehicles.length === 0 && (
                <div className="py-20 text-center rounded-2xl border border-white/[0.06] bg-[#0c0c0c]/60 p-8 max-w-xl mx-auto space-y-5">
                  <div className="w-14 h-14 rounded-xl border border-white/10 bg-white/[0.02] flex items-center justify-center mx-auto text-[#2ee6ca]">
                    <Car className="w-7 h-7" />
                  </div>
                  <div className="space-y-2">
                    <h3 className="font-display text-xl font-bold uppercase text-white">
                      No Vehicles in Your Garage
                    </h3>
                    <p className="text-xs font-mono text-neutral-400 leading-relaxed">
                      Register your vehicle to generate an encrypted ParkX entry pass and unlock automated trajectory guidance.
                    </p>
                  </div>
                  <button
                    onClick={() => setCurrentView('add')}
                    className="inline-flex items-center space-x-2 px-6 py-3 rounded-lg bg-[#2ee6ca] hover:bg-[#28d1b7] text-black font-mono text-xs uppercase tracking-widest font-semibold transition-all shadow-[0_0_25px_rgba(46,230,202,0.25)]"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Register First Vehicle</span>
                  </button>
                </div>
              )}

              {/* Vehicle Cards Grid */}
              {!loading && vehicles.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {filteredVehicles.map((v) => (
                    <div
                      key={v.id}
                      onClick={() => {
                        setSelectedVehicleId(v.id);
                        setCurrentView('details');
                      }}
                      className="group relative rounded-xl border border-white/[0.08] bg-[#0d0d0d]/80 hover:bg-[#121212] hover:border-[#2ee6ca]/40 transition-all duration-300 p-6 flex flex-col justify-between cursor-pointer shadow-lg hover:shadow-[0_0_30px_rgba(46,230,202,0.12)]"
                    >
                      <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-transparent to-transparent group-hover:via-[#2ee6ca] transition-all duration-300 rounded-t-xl" />

                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <span className="px-3 py-1 rounded bg-[#161616] border border-white/[0.1] text-xs font-mono font-bold tracking-widest text-[#2ee6ca]">
                            {v.registrationNumber}
                          </span>
                          <span className="px-2 py-0.5 rounded border border-white/[0.08] text-[10px] font-mono uppercase tracking-widest text-neutral-400">
                            {v.vehicleType}
                          </span>
                        </div>

                        <div>
                          <h3 className="font-display text-lg font-bold text-white group-hover:text-[#2ee6ca] transition-colors uppercase">
                            {v.vehicleModel}
                          </h3>
                          <div className="flex items-center space-x-2 text-xs font-mono text-neutral-400 mt-1">
                            <Palette className="w-3.5 h-3.5 text-neutral-500" />
                            <span>{v.color}</span>
                          </div>
                        </div>
                      </div>

                      <div className="pt-6 mt-4 border-t border-white/[0.06] flex items-center justify-between">
                        <div className="flex items-center space-x-2 text-[11px] font-mono text-neutral-400">
                          <QrCode className="w-3.5 h-3.5 text-[#2ee6ca]" />
                          <span>{v.qrCode ? 'Pass Active' : 'Pass Configured'}</span>
                        </div>

                        <div className="flex items-center space-x-1 text-xs font-mono text-[#2ee6ca] group-hover:translate-x-1 transition-transform">
                          <span>View Pass</span>
                          <ArrowRight className="w-3.5 h-3.5" />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: INCOMING VISITOR CONTACT REQUESTS (Phase 3.2) */}
          {activeTab === 'requests' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-neutral-400">
                  Total Contact Requests: <strong className="text-white font-bold">{sessions.length}</strong>
                </span>

                <button
                  onClick={loadSessions}
                  disabled={sessionsLoading}
                  className="inline-flex items-center space-x-1.5 text-xs font-mono text-[#2ee6ca] hover:text-[#28d1b7] uppercase tracking-wider"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${sessionsLoading ? 'animate-spin' : ''}`} />
                  <span>Refresh Sessions</span>
                </button>
              </div>

              {sessionsLoading && sessions.length === 0 ? (
                <div className="py-20 flex flex-col items-center justify-center space-y-3">
                  <Loader2 className="w-8 h-8 text-[#2ee6ca] animate-spin" />
                  <span className="text-xs font-mono text-neutral-400">Loading incoming visitor sessions...</span>
                </div>
              ) : sessions.length === 0 ? (
                <div className="py-16 text-center rounded-xl border border-white/[0.06] bg-[#0c0c0c]/50 p-6 space-y-3">
                  <MessageSquare className="w-8 h-8 text-neutral-600 mx-auto" />
                  <h3 className="font-mono text-sm font-semibold uppercase text-neutral-300">
                    No Visitor Requests Received
                  </h3>
                  <p className="text-xs font-mono text-neutral-500 max-w-md mx-auto">
                    When someone scans your vehicle QR code and taps &quot;Contact Vehicle Owner&quot;, their anonymous session will appear here.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {sessions.map((s) => (
                    <div
                      key={s.sessionId}
                      className="p-5 rounded-xl border border-white/[0.08] bg-[#0d0d0d]/90 space-y-3.5 text-xs font-mono"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center space-x-2">
                          <span
                            className={`w-2.5 h-2.5 rounded-full ${
                              s.status === 'pending'
                                ? 'bg-amber-400 animate-pulse'
                                : s.status === 'accepted'
                                ? 'bg-[#2ee6ca]'
                                : 'bg-neutral-600'
                            }`}
                          />
                          <span className="font-semibold text-white uppercase">
                            {s.vehicle?.vehicleModel || 'Vehicle'} ({s.vehicle?.registrationNumber || 'PX'})
                          </span>
                        </div>

                        <span
                          className={`uppercase px-2 py-0.5 rounded text-[10px] font-semibold ${
                            s.status === 'pending'
                              ? 'bg-amber-400/10 text-amber-400 border border-amber-400/30'
                              : s.status === 'accepted'
                              ? 'bg-[#2ee6ca]/10 text-[#2ee6ca] border border-[#2ee6ca]/30'
                              : 'bg-neutral-800 text-neutral-400'
                          }`}
                        >
                          {s.status}
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-[11px] text-neutral-400 border-t border-b border-white/[0.04] py-2">
                        <span>Ref: {s.sessionId.slice(0, 16)}...</span>
                        <span>{new Date(s.createdAt).toLocaleString()}</span>
                      </div>

                      <div className="flex items-center space-x-2 pt-1">
                        {s.status === 'pending' && (
                          <button
                            onClick={() => handleAcceptSession(s.sessionId)}
                            disabled={actionLoadingId === s.sessionId}
                            className="flex-1 inline-flex items-center justify-center space-x-1.5 py-2 rounded bg-[#2ee6ca] hover:bg-[#28d1b7] text-black font-semibold uppercase text-xs tracking-wider transition-colors disabled:opacity-50"
                          >
                            {actionLoadingId === s.sessionId ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <CheckCircle className="w-3.5 h-3.5" />
                            )}
                            <span>Accept Request</span>
                          </button>
                        )}

                        {(s.status === 'pending' || s.status === 'accepted') && (
                          <button
                            onClick={() => handleCloseSession(s.sessionId)}
                            disabled={actionLoadingId === s.sessionId}
                            className="inline-flex items-center justify-center space-x-1.5 px-3 py-2 rounded border border-red-500/20 bg-red-500/10 hover:bg-red-500/20 text-red-400 uppercase text-xs tracking-wider transition-colors disabled:opacity-50"
                          >
                            {actionLoadingId === s.sessionId ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <XCircle className="w-3.5 h-3.5" />
                            )}
                            <span>Close</span>
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
