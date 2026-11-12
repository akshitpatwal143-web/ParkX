import React, { useState, useEffect, useRef } from 'react';
import { generateQrDataUrl, QR_TOKEN_UNAVAILABLE_MESSAGE } from '../../services/qrPass';
import {
  Car,
  QrCode as QrIcon,
  RefreshCw,
  Trash2,
  Edit2,
  Check,
  X,
  ArrowLeft,
  Download,
  ShieldCheck,
  AlertTriangle,
  Loader2,
  Calendar,
  Palette,
  Hash,
  Sparkles,
} from 'lucide-react';
import { updateVehicle, deleteVehicle, rotateQrCode, fetchVehicle } from '../../services/vehicleService';

export default function VehicleDetails({ vehicleId, onBack, onVehicleDeleted, onVehicleUpdated, initialQrToken, onInitialQrTokenConsumed }) {
  const [vehicle, setVehicle] = useState(null);
  const [qrHistory, setQrHistory] = useState([]);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [qrUnavailable, setQrUnavailable] = useState(!initialQrToken);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Edit State
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    registration_number: '',
    vehicle_type: 'car',
    vehicle_model: '',
    color: '',
  });
  const [editErrors, setEditErrors] = useState({});
  const [isUpdating, setIsUpdating] = useState(false);

  // Actions Loading State
  const [isRotating, setIsRotating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const canvasRef = useRef(null);

  // Load details
  const loadDetails = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchVehicle(vehicleId);
      setVehicle(data.vehicle);
      setQrHistory(data.qrHistory || []);
      setEditForm({
        registration_number: data.vehicle.registrationNumber || '',
        vehicle_type: data.vehicle.vehicleType || 'car',
        vehicle_model: data.vehicle.vehicleModel || '',
        color: data.vehicle.color || '',
      });

    } catch (err) {
      setError(err.message || 'Failed to load vehicle details');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (vehicleId) {
      loadDetails();
    }
  }, [vehicleId]);

  useEffect(() => {
    let active = true;
    if (initialQrToken) {
      generateQrDataUrl(initialQrToken).then((url) => {
        if (active) { setQrDataUrl(url); setQrUnavailable(false); }
      }).catch(() => {
        if (active) { setQrDataUrl(''); setQrUnavailable(true); setError('The QR pass could not be rendered. Rotate the token to generate a new pass.'); }
      }).finally(() => onInitialQrTokenConsumed?.());
    }
    return () => { active = false; };
  }, [initialQrToken]);

  const generateQrImage = async (token) => {
    try {
      const url = await generateQrDataUrl(token);
      setQrDataUrl(url);
      setQrUnavailable(false);
      return true;
    } catch (err) {
      setQrDataUrl('');
      setQrUnavailable(true);
      return false;
    }
  };

  // Handle Edit Submit
  const handleUpdate = async (e) => {
    e.preventDefault();
    setIsUpdating(true);
    setEditErrors({});

    try {
      const res = await updateVehicle(vehicleId, {
        registration_number: editForm.registration_number.trim().toUpperCase(),
        vehicle_type: editForm.vehicle_type,
        vehicle_model: editForm.vehicle_model.trim(),
        color: editForm.color.trim(),
      });
      setVehicle(res.vehicle);
      setIsEditing(false);
      if (onVehicleUpdated) onVehicleUpdated(res.vehicle);
    } catch (err) {
      if (err.errors) setEditErrors(err.errors);
      else setError(err.message || 'Failed to update vehicle');
    } finally {
      setIsUpdating(false);
    }
  };

  // Handle Rotate QR Code
  const handleRotateQr = async () => {
    setIsRotating(true);
    setError('');
    try {
      const res = await rotateQrCode(vehicleId);
      const newToken = res.qrCode?.token;
      setQrDataUrl('');
      if (!newToken || !(await generateQrImage(newToken))) {
        setError('The token was rotated, but its pass could not be rendered. Rotate again to generate a new pass.');
      }
      await loadDetails();
    } catch (err) {
      setError(err.message || 'Failed to rotate QR code');
    } finally {
      setIsRotating(false);
    }
  };

  // Handle Delete Vehicle
  const handleDelete = async () => {
    setIsDeleting(true);
    setError('');
    try {
      await deleteVehicle(vehicleId);
      if (onVehicleDeleted) {
        onVehicleDeleted(vehicleId);
      }
    } catch (err) {
      setError(err.message || 'Failed to delete vehicle');
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  // Download QR Code image
  const handleDownloadQr = () => {
    if (!qrDataUrl) return;
    const link = document.createElement('a');
    link.download = `ParkX-QR-${vehicle?.registrationNumber || 'Key'}.png`;
    link.href = qrDataUrl;
    link.click();
  };

  if (loading) {
    return (
      <div className="py-24 flex flex-col items-center justify-center space-y-3">
        <Loader2 className="w-8 h-8 text-[#2ee6ca] animate-spin" />
        <span className="text-xs font-mono tracking-widest uppercase text-neutral-400">
          Loading Vehicle Telemetry...
        </span>
      </div>
    );
  }

  if (error && !vehicle) {
    return (
      <div className="max-w-2xl mx-auto py-12">
        <div className="p-6 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 font-mono text-sm">
          {error}
        </div>
        <button
          onClick={onBack}
          className="mt-6 inline-flex items-center space-x-2 text-xs font-mono text-[#2ee6ca] uppercase tracking-wider"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Return to Garage</span>
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* Top Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8 pb-4 border-b border-white/[0.08]">
        <div>
          <button
            onClick={onBack}
            className="inline-flex items-center space-x-2 text-xs font-mono text-neutral-400 hover:text-[#2ee6ca] transition-colors mb-2 uppercase tracking-wider"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Garage</span>
          </button>
          <div className="flex items-center space-x-3">
            <h2 className="font-display text-2xl md:text-3xl font-bold tracking-tight text-white uppercase">
              {vehicle?.vehicleModel}
            </h2>
            <span className="px-2.5 py-0.5 rounded border border-[#2ee6ca]/30 bg-[#2ee6ca]/10 text-[#2ee6ca] text-[11px] font-mono uppercase tracking-widest">
              {vehicle?.vehicleType}
            </span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center space-x-3">
          {!isEditing ? (
            <button
              onClick={() => setIsEditing(true)}
              className="inline-flex items-center space-x-1.5 px-3.5 py-2 rounded-lg border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.06] text-neutral-300 hover:text-white text-xs font-mono uppercase tracking-widest transition-colors"
            >
              <Edit2 className="w-3.5 h-3.5" />
              <span>Edit</span>
            </button>
          ) : (
            <button
              onClick={() => setIsEditing(false)}
              className="inline-flex items-center space-x-1.5 px-3.5 py-2 rounded-lg border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.06] text-neutral-400 hover:text-white text-xs font-mono uppercase tracking-widest transition-colors"
            >
              <X className="w-3.5 h-3.5" />
              <span>Cancel</span>
            </button>
          )}

          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="inline-flex items-center space-x-1.5 px-3.5 py-2 rounded-lg border border-red-500/20 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-mono uppercase tracking-widest transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Delete</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-mono">
          {error}
        </div>
      )}

      {/* Main Grid: Details + QR Access Key */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Specifications / Edit Form */}
        <div className="lg:col-span-7 space-y-6">
          {isEditing ? (
            /* Edit Form */
            <form onSubmit={handleUpdate} className="p-6 rounded-xl bg-[#0f0f0f] border border-white/[0.08] space-y-5">
              <h3 className="text-sm font-mono tracking-widest uppercase text-[#2ee6ca] flex items-center space-x-2">
                <Edit2 className="w-4 h-4" />
                <span>Update Vehicle Telemetry</span>
              </h3>

              <div className="space-y-1.5">
                <label className="text-[11px] font-mono tracking-widest uppercase text-neutral-400">
                  Registration Number
                </label>
                <input
                  type="text"
                  value={editForm.registration_number}
                  onChange={(e) => setEditForm((p) => ({ ...p, registration_number: e.target.value.toUpperCase() }))}
                  className="w-full bg-[#161616] border border-white/[0.08] rounded-lg px-4 py-2.5 text-sm font-mono text-white uppercase focus:border-[#2ee6ca]/50 outline-none"
                />
                {editErrors.registration_number && (
                  <p className="text-[11px] font-mono text-red-400">{editErrors.registration_number}</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-mono tracking-widest uppercase text-neutral-400">
                    Type
                  </label>
                  <select
                    value={editForm.vehicle_type}
                    onChange={(e) => setEditForm((p) => ({ ...p, vehicle_type: e.target.value }))}
                    className="w-full bg-[#161616] border border-white/[0.08] rounded-lg px-4 py-2.5 text-sm text-white focus:border-[#2ee6ca]/50 outline-none"
                  >
                    <option value="car">Car</option>
                    <option value="suv">SUV</option>
                    <option value="ev">Electric Vehicle</option>
                    <option value="motorcycle">Motorcycle</option>
                    <option value="truck">Truck</option>
                    <option value="van">Van</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-mono tracking-widest uppercase text-neutral-400">
                    Color
                  </label>
                  <input
                    type="text"
                    value={editForm.color}
                    onChange={(e) => setEditForm((p) => ({ ...p, color: e.target.value }))}
                    className="w-full bg-[#161616] border border-white/[0.08] rounded-lg px-4 py-2.5 text-sm text-white focus:border-[#2ee6ca]/50 outline-none"
                  />
                  {editErrors.color && (
                    <p className="text-[11px] font-mono text-red-400">{editErrors.color}</p>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] font-mono tracking-widest uppercase text-neutral-400">
                  Model
                </label>
                <input
                  type="text"
                  value={editForm.vehicle_model}
                  onChange={(e) => setEditForm((p) => ({ ...p, vehicle_model: e.target.value }))}
                  className="w-full bg-[#161616] border border-white/[0.08] rounded-lg px-4 py-2.5 text-sm text-white focus:border-[#2ee6ca]/50 outline-none"
                />
                {editErrors.vehicle_model && (
                  <p className="text-[11px] font-mono text-red-400">{editErrors.vehicle_model}</p>
                )}
              </div>

              <div className="pt-2 flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  className="px-4 py-2 rounded-lg border border-white/[0.08] text-neutral-400 hover:text-white text-xs font-mono uppercase"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isUpdating}
                  className="inline-flex items-center space-x-1.5 px-5 py-2 rounded-lg bg-[#2ee6ca] hover:bg-[#28d1b7] text-black text-xs font-mono uppercase font-semibold"
                >
                  {isUpdating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  <span>Save Changes</span>
                </button>
              </div>
            </form>
          ) : (
            /* Vehicle Specs Card */
            <div className="p-6 rounded-xl bg-[#0f0f0f] border border-white/[0.08] space-y-6">
              <div className="flex items-center justify-between pb-4 border-b border-white/[0.06]">
                <span className="text-xs font-mono tracking-widest uppercase text-neutral-400">
                  Vehicle Registration
                </span>
                <span className="px-3 py-1 rounded bg-[#181818] border border-white/[0.12] text-sm font-mono font-bold tracking-widest text-[#2ee6ca]">
                  {vehicle?.registrationNumber}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div>
                  <span className="text-[11px] font-mono uppercase tracking-wider text-neutral-500 block mb-1">
                    Exterior Finish
                  </span>
                  <div className="flex items-center space-x-2 text-sm text-white font-mono">
                    <Palette className="w-4 h-4 text-[#2ee6ca]" />
                    <span>{vehicle?.color}</span>
                  </div>
                </div>

                <div>
                  <span className="text-[11px] font-mono uppercase tracking-wider text-neutral-500 block mb-1">
                    Vehicle Classification
                  </span>
                  <div className="flex items-center space-x-2 text-sm text-white font-mono uppercase">
                    <Car className="w-4 h-4 text-[#2ee6ca]" />
                    <span>{vehicle?.vehicleType}</span>
                  </div>
                </div>

                <div>
                  <span className="text-[11px] font-mono uppercase tracking-wider text-neutral-500 block mb-1">
                    Registered On
                  </span>
                  <div className="flex items-center space-x-2 text-xs text-neutral-300 font-mono">
                    <Calendar className="w-4 h-4 text-neutral-400" />
                    <span>{vehicle?.createdAt ? new Date(vehicle.createdAt).toLocaleDateString() : 'N/A'}</span>
                  </div>
                </div>

                <div>
                  <span className="text-[11px] font-mono uppercase tracking-wider text-neutral-500 block mb-1">
                    Security Authorization
                  </span>
                  <div className="flex items-center space-x-2 text-xs text-emerald-400 font-mono">
                    <ShieldCheck className="w-4 h-4" />
                    <span>Verified Owner</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* QR Code Audit History */}
          <div className="p-6 rounded-xl bg-[#0f0f0f] border border-white/[0.08] space-y-4">
            <h3 className="text-xs font-mono tracking-widest uppercase text-neutral-300 flex items-center justify-between">
              <span>QR Issuance &amp; Revocation History</span>
              <span className="text-[10px] text-neutral-500">{qrHistory.length} Record(s)</span>
            </h3>

            {qrHistory.length === 0 ? (
              <p className="text-xs font-mono text-neutral-500">No previous QR tokens recorded.</p>
            ) : (
              <div className="space-y-2">
                {qrHistory.map((qr) => (
                  <div
                    key={qr.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-[#141414] border border-white/[0.04] text-xs font-mono"
                  >
                    <div className="flex items-center space-x-2.5">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          qr.status === 'active' ? 'bg-[#2ee6ca] animate-pulse' : 'bg-neutral-600'
                        }`}
                      />
                      <span className="text-neutral-300 uppercase tracking-wider">
                        Token Key #{qr.id}
                      </span>
                    </div>

                    <div className="flex items-center space-x-4 text-neutral-400 text-[11px]">
                      <span>{new Date(qr.created_at).toLocaleDateString()}</span>
                      <span
                        className={`uppercase tracking-wider px-2 py-0.5 rounded text-[10px] ${
                          qr.status === 'active'
                            ? 'bg-[#2ee6ca]/10 text-[#2ee6ca] border border-[#2ee6ca]/30'
                            : 'bg-neutral-800 text-neutral-400'
                        }`}
                      >
                        {qr.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: QR Access Pass */}
        <div className="lg:col-span-5 space-y-6">
          <div className="p-6 rounded-xl bg-[#0f0f0f] border border-white/[0.08] flex flex-col items-center text-center space-y-4">
            <div className="flex items-center space-x-2 text-xs font-mono tracking-widest uppercase text-[#2ee6ca]">
              <QrIcon className="w-4 h-4" />
              <span>Autonomous Entry Key</span>
            </div>

            {/* QR Card Container */}
            <div className="p-4 rounded-xl bg-[#2ee6ca] shadow-[0_0_40px_rgba(46,230,202,0.2)]">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt={`QR code for ${vehicle?.registrationNumber}`}
                  className="w-48 h-48 rounded"
                />
              ) : (
                  <div className="w-48 h-48 flex items-center justify-center bg-black/10 text-black font-mono text-xs p-3">
                  {qrUnavailable ? 'Pass unavailable' : 'Generating QR...'}
                </div>
              )}
            </div>

            <p className="text-[11px] font-mono text-neutral-400 max-w-xs leading-relaxed">
              {qrUnavailable ? QR_TOKEN_UNAVAILABLE_MESSAGE : 'This QR pass contains the newly issued owner token.'}
            </p>

            {/* QR Actions */}
            <div className="w-full pt-2 flex flex-col space-y-2.5">
              <button
                onClick={handleDownloadQr}
                disabled={!qrDataUrl}
                className="w-full inline-flex items-center justify-center space-x-2 py-2.5 rounded-lg border border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.08] text-white text-xs font-mono uppercase tracking-widest transition-colors"
              >
                <Download className="w-3.5 h-3.5 text-[#2ee6ca]" />
                <span>Save Entry Pass (PNG)</span>
              </button>

              <button
                onClick={handleRotateQr}
                disabled={isRotating}
                className="w-full inline-flex items-center justify-center space-x-2 py-2.5 rounded-lg border border-[#2ee6ca]/30 bg-[#2ee6ca]/10 hover:bg-[#2ee6ca]/20 text-[#2ee6ca] text-xs font-mono uppercase tracking-widest transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRotating ? 'animate-spin' : ''}`} />
                <span>{isRotating ? 'Rotating...' : 'Rotate Security Token'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fadeIn">
          <div className="max-w-md w-full bg-[#121212] border border-red-500/30 rounded-xl p-6 space-y-4">
            <div className="flex items-center space-x-3 text-red-400">
              <AlertTriangle className="w-6 h-6" />
              <h3 className="font-display text-lg font-bold uppercase">Confirm Vehicle Deletion</h3>
            </div>
            <p className="text-xs font-mono text-neutral-300 leading-relaxed">
              Are you sure you want to remove <strong className="text-white">{vehicle?.vehicleModel} ({vehicle?.registrationNumber})</strong>? All associated QR access tokens will be permanently revoked.
            </p>
            <div className="flex justify-end space-x-3 pt-2">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={isDeleting}
                className="px-4 py-2 rounded-lg border border-white/[0.08] text-neutral-400 hover:text-white text-xs font-mono uppercase"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="inline-flex items-center space-x-2 px-4 py-2 rounded-lg bg-red-500 hover:bg-red-600 text-white text-xs font-mono uppercase font-semibold disabled:opacity-50"
              >
                {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                <span>Delete Vehicle</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
