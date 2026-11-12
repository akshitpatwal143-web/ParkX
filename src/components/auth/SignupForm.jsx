import React, { useState } from 'react';
import { User, Mail, Lock, Eye, EyeOff, ArrowRight, Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { signup as signupApi } from '../../services/authService';

export default function SignupForm() {
  const { switchToLogin, closeModal, setUser, isLoading, setIsLoading } = useAuth();

  const [form, setForm] = useState({ name: '', email: '', password: '', confirmPassword: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [errors, setErrors] = useState({});
  const [apiError, setApiError] = useState('');

  const update = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: '' }));
    setApiError('');
  };

  const validate = () => {
    const e = {};
    if (!form.name.trim()) e.name = 'Full name is required';
    if (!form.email.trim()) e.email = 'Email is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = 'Enter a valid email';
    if (!form.password) e.password = 'Password is required';
    else if (form.password.length < 8) e.password = 'Minimum 8 characters';
    if (!form.confirmPassword) e.confirmPassword = 'Please confirm your password';
    else if (form.password !== form.confirmPassword) e.confirmPassword = 'Passwords do not match';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;
    setIsLoading(true);
    setApiError('');
    try {
      const { user } = await signupApi({
        name: form.name,
        email: form.email,
        password: form.password,
      });
      setUser(user);
      closeModal();
    } catch (err) {
      setApiError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const inputBase =
    'w-full bg-white/[0.04] border border-white/[0.08] rounded-lg pl-11 pr-4 py-3 text-sm text-white placeholder-neutral-500 outline-none transition-all duration-300 focus:border-[#2ee6ca]/50 focus:bg-white/[0.06] focus:ring-1 focus:ring-[#2ee6ca]/20';

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {/* ---- Heading ---- */}
      <div className="text-center space-y-1.5">
        <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-white">
          Create Account
        </h2>
        <p className="text-sm text-neutral-400 font-mono tracking-wide">
          Join the future of autonomous parking
        </p>
      </div>

      {/* ---- API Error ---- */}
      {apiError && (
        <div className="px-4 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-mono text-center">
          {apiError}
        </div>
      )}

      {/* ---- Full Name ---- */}
      <div className="space-y-1.5">
        <label htmlFor="signup-name" className="text-[11px] font-mono tracking-widest uppercase text-neutral-400">
          Full Name
        </label>
        <div className="relative">
          <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
          <input
            id="signup-name"
            type="text"
            autoComplete="name"
            placeholder="John Doe"
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
            className={`${inputBase} ${errors.name ? 'border-red-500/50 focus:border-red-500/50 focus:ring-red-500/20' : ''}`}
          />
        </div>
        {errors.name && <p className="text-[11px] text-red-400 font-mono pl-1">{errors.name}</p>}
      </div>

      {/* ---- Email ---- */}
      <div className="space-y-1.5">
        <label htmlFor="signup-email" className="text-[11px] font-mono tracking-widest uppercase text-neutral-400">
          Email Address
        </label>
        <div className="relative">
          <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
          <input
            id="signup-email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={form.email}
            onChange={(e) => update('email', e.target.value)}
            className={`${inputBase} ${errors.email ? 'border-red-500/50 focus:border-red-500/50 focus:ring-red-500/20' : ''}`}
          />
        </div>
        {errors.email && <p className="text-[11px] text-red-400 font-mono pl-1">{errors.email}</p>}
      </div>

      {/* ---- Password ---- */}
      <div className="space-y-1.5">
        <label htmlFor="signup-password" className="text-[11px] font-mono tracking-widest uppercase text-neutral-400">
          Password
        </label>
        <div className="relative">
          <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
          <input
            id="signup-password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder="••••••••"
            value={form.password}
            onChange={(e) => update('password', e.target.value)}
            className={`${inputBase} pr-11 ${errors.password ? 'border-red-500/50 focus:border-red-500/50 focus:ring-red-500/20' : ''}`}
          />
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setShowPassword((v) => !v)}
            className="absolute right-3.5 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300 transition-colors"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        {errors.password && <p className="text-[11px] text-red-400 font-mono pl-1">{errors.password}</p>}
      </div>

      {/* ---- Confirm Password ---- */}
      <div className="space-y-1.5">
        <label htmlFor="signup-confirm" className="text-[11px] font-mono tracking-widest uppercase text-neutral-400">
          Confirm Password
        </label>
        <div className="relative">
          <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
          <input
            id="signup-confirm"
            type={showConfirm ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder="••••••••"
            value={form.confirmPassword}
            onChange={(e) => update('confirmPassword', e.target.value)}
            className={`${inputBase} pr-11 ${errors.confirmPassword ? 'border-red-500/50 focus:border-red-500/50 focus:ring-red-500/20' : ''}`}
          />
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setShowConfirm((v) => !v)}
            className="absolute right-3.5 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300 transition-colors"
            aria-label={showConfirm ? 'Hide password' : 'Show password'}
          >
            {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        {errors.confirmPassword && (
          <p className="text-[11px] text-red-400 font-mono pl-1">{errors.confirmPassword}</p>
        )}
      </div>

      {/* ---- Submit ---- */}
      <button
        type="submit"
        disabled={isLoading}
        className="group w-full flex items-center justify-center space-x-2 py-3.5 rounded-lg bg-[#2ee6ca] hover:bg-[#28d1b7] active:bg-[#22b8a1] text-black font-mono text-xs uppercase tracking-widest font-semibold transition-all duration-300 shadow-[0_0_30px_rgba(46,230,202,0.25)] disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {isLoading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <>
            <span>Create Account</span>
            <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
          </>
        )}
      </button>

      {/* ---- Switch to Login ---- */}
      <p className="text-center text-xs text-neutral-400 font-mono tracking-wide pt-1">
        Already have an account?{' '}
        <button
          type="button"
          onClick={switchToLogin}
          className="text-[#2ee6ca] hover:text-[#2ee6ca]/80 transition-colors font-semibold"
        >
          Sign in
        </button>
      </p>
    </form>
  );
}
