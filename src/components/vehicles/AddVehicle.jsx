import React, { useState } from 'react';
import { Car, Hash, Palette, Sparkles, Loader2, AlertCircle, ArrowLeft } from 'lucide-react';
import { registerVehicle } from '../../services/vehicleService';

const VEHICLE_TYPES = [
  { value: 'car', label: 'Car' },
  { value: 'suv', label: 'SUV' },
  { value: 'ev', label: 'Electric Vehicle (EV)' },
  { value: 'motorcycle', label: 'Motorcycle' },
  { value: 'truck', label: 'Truck' },
  { value: 'van', label: 'Van' },
  { value: 'other', label: 'Other' },
];

export default function AddVehicle({ onVehicleCreated, onCancel }) {
  const [formData, setFormData] = useState({
    registration_number: '',
    vehicle_type: 'car',
    vehicle_model: '',
    color: '',
  });
  const [errors, setErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const handleChange = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: '' }));
    setSubmitError('');
  };

  const validate = () => {
    const errs = {};
    const reg = formData.registration_number.trim().toUpperCase();
    if (!reg) errs.registration_number = 'Registration number is required';
    else if (reg.length < 2 || reg.length > 50) errs.registration_number = 'Must be between 2 and 50 characters';

    if (!formData.vehicle_model.trim()) errs.vehicle_model = 'Vehicle model is required';
    if (!formData.color.trim()) errs.color = 'Color is required';
    if (!formData.vehicle_type) errs.vehicle_type = 'Vehicle type is required';

    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;

    setIsSubmitting(true);
    setSubmitError('');

    try {
      const result = await registerVehicle({
        registration_number: formData.registration_number.trim().toUpperCase(),
        vehicle_type: formData.vehicle_type,
        vehicle_model: formData.vehicle_model.trim(),
        color: formData.color.trim(),
      });

      if (onVehicleCreated) {
        onVehicleCreated(result.vehicle);
      }
    } catch (err) {
      if (err.errors) {
        setErrors(err.errors);
      }
      setSubmitError(err.message || 'Failed to register vehicle. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const inputClass = (field) =>
    `w-full bg-[#121212] border ${
      errors[field] ? 'border-red-500/50 focus:border-red-500' : 'border-white/[0.08] focus:border-[#2ee6ca]/50'
    } rounded-lg px-4 py-3 text-sm text-white placeholder-neutral-500 outline-none transition-all duration-200 focus:bg-[#161616] focus:ring-1 focus:ring-[#2ee6ca]/20`;

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8 pb-4 border-b border-white/[0.08]">
        <div>
          <button
            onClick={onCancel}
            className="inline-flex items-center space-x-2 text-xs font-mono text-neutral-400 hover:text-[#2ee6ca] transition-colors mb-3 uppercase tracking-wider"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Garage</span>
          </button>
          <h2 className="font-display text-2xl md:text-3xl font-bold tracking-tight text-white uppercase">
            Register New Vehicle
          </h2>
          <p className="text-xs font-mono text-neutral-400 tracking-wide mt-1">
            Generate an autonomous ParkX entry profile and cryptographic QR key
          </p>
        </div>
      </div>

      {/* Global Error Notice */}
      {submitError && (
        <div className="mb-6 p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-mono flex items-center space-x-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{submitError}</span>
        </div>
      )}

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Registration Number */}
        <div className="space-y-1.5">
          <label className="flex items-center justify-between text-xs font-mono tracking-widest uppercase text-neutral-300">
            <span className="flex items-center space-x-2">
              <Hash className="w-3.5 h-3.5 text-[#2ee6ca]" />
              <span>License / Registration Number</span>
            </span>
            <span className="text-[10px] text-neutral-500">Unique identifier</span>
          </label>
          <input
            type="text"
            placeholder="e.g. PX-4829, NY-8492"
            value={formData.registration_number}
            onChange={(e) => handleChange('registration_number', e.target.value.toUpperCase())}
            className={`${inputClass('registration_number')} font-mono uppercase tracking-wider`}
            maxLength={50}
          />
          {errors.registration_number && (
            <p className="text-[11px] font-mono text-red-400 pl-1">{errors.registration_number}</p>
          )}
        </div>

        {/* Vehicle Type & Color Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Vehicle Type */}
          <div className="space-y-1.5">
            <label className="flex items-center space-x-2 text-xs font-mono tracking-widest uppercase text-neutral-300">
              <Car className="w-3.5 h-3.5 text-[#2ee6ca]" />
              <span>Vehicle Type</span>
            </label>
            <select
              value={formData.vehicle_type}
              onChange={(e) => handleChange('vehicle_type', e.target.value)}
              className={inputClass('vehicle_type')}
            >
              {VEHICLE_TYPES.map((t) => (
                <option key={t.value} value={t.value} className="bg-[#141414] text-white">
                  {t.label}
                </option>
              ))}
            </select>
            {errors.vehicle_type && (
              <p className="text-[11px] font-mono text-red-400 pl-1">{errors.vehicle_type}</p>
            )}
          </div>

          {/* Color */}
          <div className="space-y-1.5">
            <label className="flex items-center space-x-2 text-xs font-mono tracking-widest uppercase text-neutral-300">
              <Palette className="w-3.5 h-3.5 text-[#2ee6ca]" />
              <span>Exterior Color</span>
            </label>
            <input
              type="text"
              placeholder="e.g. Jet Black Metallic, Chalk"
              value={formData.color}
              onChange={(e) => handleChange('color', e.target.value)}
              className={inputClass('color')}
              maxLength={50}
            />
            {errors.color && (
              <p className="text-[11px] font-mono text-red-400 pl-1">{errors.color}</p>
            )}
          </div>
        </div>

        {/* Vehicle Model */}
        <div className="space-y-1.5">
          <label className="flex items-center space-x-2 text-xs font-mono tracking-widest uppercase text-neutral-300">
            <Sparkles className="w-3.5 h-3.5 text-[#2ee6ca]" />
            <span>Make & Model</span>
          </label>
          <input
            type="text"
            placeholder="e.g. Porsche Taycan 4S, Tesla Model S"
            value={formData.vehicle_model}
            onChange={(e) => handleChange('vehicle_model', e.target.value)}
            className={inputClass('vehicle_model')}
            maxLength={100}
          />
          {errors.vehicle_model && (
            <p className="text-[11px] font-mono text-red-400 pl-1">{errors.vehicle_model}</p>
          )}
        </div>

        {/* Action Buttons */}
        <div className="pt-4 flex items-center justify-end space-x-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="px-5 py-3 rounded-lg border border-white/[0.08] text-neutral-400 hover:text-white hover:border-white/20 text-xs font-mono uppercase tracking-widest transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="inline-flex items-center space-x-2 px-6 py-3 rounded-lg bg-[#2ee6ca] hover:bg-[#28d1b7] text-black font-mono text-xs uppercase tracking-widest font-semibold transition-all shadow-[0_0_25px_rgba(46,230,202,0.25)] hover:shadow-[0_0_35px_rgba(46,230,202,0.35)] disabled:opacity-50"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Registering...</span>
              </>
            ) : (
              <span>Save & Generate QR</span>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
