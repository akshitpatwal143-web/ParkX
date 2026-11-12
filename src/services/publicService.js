/**
 * Public vehicle verification API client.
 * Calls the unauthenticated public verification endpoint.
 * Note: Never store raw tokens in localStorage or sessionStorage.
 */

const API_BASE = '/api/public/vehicles';

export async function verifyPublicToken(token, { signal } = {}) {
  if (!token || typeof token !== 'string') {
    return {
      status: 'invalid',
      message: 'Missing or invalid QR pass token.',
    };
  }

  try {
    const res = await fetch(`${API_BASE}/${encodeURIComponent(token.trim())}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      signal,
    });

    const data = await res.json().catch(() => ({}));

    if (res.status === 200 && data.status === 'valid') {
      return {
        status: 'valid',
        vehicle: data.vehicle,
      };
    }

    if (res.status === 410 || data.status === 'revoked') {
      return {
        status: 'revoked',
        message: data.message || 'This ParkX pass has been revoked by the vehicle owner.',
      };
    }

    if (res.status === 429) {
      return {
        status: 'rate_limited',
        message: 'Too many verification attempts. Please wait a moment and try again.',
      };
    }

    if (res.status === 400 || res.status === 404 || data.status === 'invalid') {
      return {
        status: 'invalid',
        message: data.message || 'Invalid or unrecognized QR pass.',
      };
    }

    return {
      status: 'unavailable',
      message: data.message || 'Verification service temporarily unavailable.',
    };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const abortError = new Error('Verification request aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }
    return {
      status: 'unavailable',
      message: 'Unable to reach the ParkX verification network. Please check your connection.',
    };
  }
}
