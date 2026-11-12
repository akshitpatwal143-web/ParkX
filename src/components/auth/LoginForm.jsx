import React, { useState } from 'react';
import { Mail, Lock, Eye, EyeOff, ArrowRight, Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { login as loginApi } from '../../services/authService';

export default function LoginForm() {
  const { switchToSignup, closeModal, setUser, isLoading, setIsLoading } = useAuth();

  const [form, setForm] = useState({ email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState({});
  const [apiError, setApiError] = useState('');

  const update = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: '' }));
    setApiError('');
  };

  const validate = () => {
    const e = {};
    if (!form.email.trim()) e.email = 'Email is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = 'Enter a valid email';
    if (!form.password) e.password = 'Password is required';
    else if (form.password.length < 6) e.password = 'Minimum 6 characters';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;
    setIsLoading(true);
    setApiError('');
    try {
      const { user } = await loginApi({ email: form.email, password: form.password });
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
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      {/* ---- Heading ---- */}
      <div className="text-center space-y-1.5">
        <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-white">
          Welcome Back
        </h2>
        <p className="text-sm text-neutral-400 font-mono tracking-wide">
          Sign in to your ParkX account
        </p>
      </div>

      {/* ---- API Error ---- */}
      {apiError && (
        <div className="px-4 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-mono text-center">
          {apiError}
        </div>
      )}

      {/* ---- Email ---- */}
      <div className="space-y-1.5">
        <label htmlFor="login-email" className="text-[11px] font-mono tracking-widest uppercase text-neutral-400">
          Email Address
        </label>
        <div className="relative">
          <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
          <input
            id="login-email"
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
        <label htmlFor="login-password" className="text-[11px] font-mono tracking-widest uppercase text-neutral-400">
          Password
        </label>
        <div className="relative">
          <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
          <input
            id="login-password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
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

      {/* ---- Forgot Password ---- */}
      <div className="flex justify-end">
        <button
          type="button"
          className="text-[11px] font-mono tracking-wider text-[#2ee6ca]/70 hover:text-[#2ee6ca] transition-colors"
        >
          Forgot Password?
        </button>
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
            <span>Sign In</span>
            <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
          </>
        )}
      </button>

      {/* ---- Switch to Signup ---- */}
      <p className="text-center text-xs text-neutral-400 font-mono tracking-wide pt-1">
        Don&apos;t have an account?{' '}
        <button
          type="button"
          onClick={switchToSignup}
          className="text-[#2ee6ca] hover:text-[#2ee6ca]/80 transition-colors font-semibold"
        >
          Create account
        </button>
      </p>
    </form>
  );
}
