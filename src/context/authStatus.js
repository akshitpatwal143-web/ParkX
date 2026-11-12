export const AUTH_UNAVAILABLE_MESSAGE = 'Authentication service unavailable. Sign-in state could not be restored. Please try again.';

export function getAuthStatus(isInitializing, authError) {
  if (isInitializing) return 'loading';
  if (authError) return 'unavailable';
  return 'ready';
}
