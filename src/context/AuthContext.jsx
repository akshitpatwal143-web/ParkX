import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { getMe, logout as apiLogout } from '../services/authService';

const AuthContext = createContext(null);

/**
 * AuthProvider — manages modal visibility state and auth session.
 *
 * modalState: null | 'login' | 'signup'
 * user:       null | { id, fullName, email, createdAt }
 */
export function AuthProvider({ children }) {
  const [modalState, setModalState] = useState(null); // null | 'login' | 'signup'
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [authError, setAuthError] = useState('');
  const authRequestId = useRef(0);

  const updateUser = useCallback((nextUser) => {
    authRequestId.current += 1;
    setUser(nextUser);
    setAuthError('');
  }, []);

  // Check existing session on application mount
  useEffect(() => {
    let isMounted = true;
    const requestId = ++authRequestId.current;
    getMe()
      .then((data) => {
        if (isMounted && authRequestId.current === requestId) {
          setUser(data?.user || null);
          setAuthError('');
        }
      })
      .catch((error) => {
        if (isMounted && authRequestId.current === requestId) {
          setUser(null);
          setAuthError(error.message || 'ParkX is temporarily unavailable.');
        }
      })
      .finally(() => {
        if (isMounted) setIsInitializing(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const openLogin  = useCallback(() => setModalState('login'), []);
  const openSignup = useCallback(() => setModalState('signup'), []);
  const closeModal = useCallback(() => setModalState(null), []);

  const switchToLogin  = useCallback(() => setModalState('login'), []);
  const switchToSignup = useCallback(() => setModalState('signup'), []);

  const logout = useCallback(async () => {
    authRequestId.current += 1;
    setAuthError('');
    try {
      await apiLogout();
      setUser(null);
    } catch (err) {
      console.error('Logout error:', err);
      setAuthError(err.message || 'Unable to sign out. Please try again.');
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        modalState,
        openLogin,
        openSignup,
        closeModal,
        switchToLogin,
        switchToSignup,
        user,
        setUser: updateUser,
        isLoading,
        setIsLoading,
        isInitializing,
        authError,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
