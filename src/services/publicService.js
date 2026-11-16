/**
 * Public vehicle verification and anonymous visitor session API client.
 * Calls the unauthenticated public endpoints.
 * Note: Never store raw tokens or credentials in URLs, console logs, or analytics.
 */

const API_BASE = '/api/public/vehicles';
const SESSIONS_BASE = '/api/public/sessions';
const STORAGE_PREFIX = 'parkx_vsession_';

// ────────────────────────────────────────────────────────────
// Browser Session Storage Helpers for Anonymous Visitors
// ────────────────────────────────────────────────────────────

export function saveStoredVisitorSession(token, sessionData) {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage && token && sessionData?.sessionId) {
      window.sessionStorage.setItem(
        `${STORAGE_PREFIX}${encodeURIComponent(token.trim())}`,
        JSON.stringify({
          sessionId: sessionData.sessionId,
          visitorCredential: sessionData.visitorCredential,
          expiresAt: sessionData.expiresAt,
          createdAt: sessionData.createdAt,
        })
      );
    }
  } catch {}
}

export function getStoredVisitorSession(token) {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage && token) {
      const raw = window.sessionStorage.getItem(`${STORAGE_PREFIX}${encodeURIComponent(token.trim())}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed.expiresAt && new Date(parsed.expiresAt).getTime() <= Date.now()) {
        clearStoredVisitorSession(token);
        return null;
      }
      return parsed;
    }
  } catch {}
  return null;
}

export function clearStoredVisitorSession(token) {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage && token) {
      window.sessionStorage.removeItem(`${STORAGE_PREFIX}${encodeURIComponent(token.trim())}`);
    }
  } catch {}
}

// ────────────────────────────────────────────────────────────
// Public Verification
// ────────────────────────────────────────────────────────────

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
        Accept: 'application/json',
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

// ────────────────────────────────────────────────────────────
// Anonymous Visitor Sessions
// ────────────────────────────────────────────────────────────

export async function createVisitorSession(token, { signal } = {}) {
  if (!token || typeof token !== 'string') {
    return {
      status: 'invalid',
      message: 'A valid QR pass token is required to contact the vehicle owner.',
    };
  }

  try {
    const res = await fetch(SESSIONS_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ token: token.trim() }),
      signal,
    });

    const data = await res.json().catch(() => ({}));

    if (res.status === 201 && data.status === 'pending') {
      saveStoredVisitorSession(token, data);
      return {
        status: 'pending',
        sessionId: data.sessionId,
        visitorCredential: data.visitorCredential,
        createdAt: data.createdAt,
        expiresAt: data.expiresAt,
        vehicle: data.vehicle,
      };
    }

    if (res.status === 410 || data.status === 'revoked') {
      return {
        status: 'revoked',
        message: data.message || 'This QR pass has been revoked and cannot accept new contact sessions.',
      };
    }

    if (res.status === 429 || data.status === 'rate_limited') {
      return {
        status: 'rate_limited',
        message: data.message || 'Too many contact requests. Please wait a few moments before trying again.',
      };
    }

    if (res.status === 400 || res.status === 404) {
      return {
        status: 'invalid',
        message: data.message || 'Invalid or unrecognized QR pass token.',
      };
    }

    return {
      status: 'unavailable',
      message: data.message || 'Contact service is temporarily unavailable. Please retry.',
    };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return {
      status: 'unavailable',
      message: 'Unable to reach the ParkX network. Please check your connection.',
    };
  }
}

export async function getVisitorSession(sessionId, credential, { signal } = {}) {
  if (!sessionId || !credential) {
    return { status: 'invalid', message: 'Session ID and visitor credential are required.' };
  }

  try {
    const res = await fetch(`${SESSIONS_BASE}/${encodeURIComponent(sessionId)}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Visitor-Credential': credential,
      },
      signal,
    });

    const data = await res.json().catch(() => ({}));

    if (res.status === 200) {
      return {
        status: data.status,
        sessionId: data.sessionId,
        createdAt: data.createdAt,
        expiresAt: data.expiresAt,
        acceptedAt: data.acceptedAt,
        closedAt: data.closedAt,
        vehicle: data.vehicle,
      };
    }

    if (res.status === 410 || data.status === 'expired') {
      return { status: 'expired', message: data.message || 'Visitor session has expired.' };
    }

    if (res.status === 401 || res.status === 403) {
      return { status: 'unauthorized', message: data.message || 'Unauthorized session access.' };
    }

    if (res.status === 404) {
      return { status: 'not_found', message: 'Visitor session not found.' };
    }

    return { status: 'unavailable', message: data.message || 'Session status unavailable.' };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return { status: 'unavailable', message: 'Unable to fetch session status.' };
  }
}

export async function closeVisitorSession(sessionId, credential, { signal } = {}) {
  if (!sessionId || !credential) {
    return { status: 'invalid', message: 'Session ID and visitor credential are required.' };
  }

  try {
    const res = await fetch(`${SESSIONS_BASE}/${encodeURIComponent(sessionId)}/close`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Visitor-Credential': credential,
      },
      body: JSON.stringify({ credential }),
      signal,
    });

    const data = await res.json().catch(() => ({}));

    if (res.status === 200 && data.status === 'closed') {
      return { status: 'closed', closedAt: data.closedAt };
    }

    if (res.status === 410 || data.status === 'expired') {
      return { status: 'expired', message: data.message || 'Session has already expired.' };
    }

    return { status: 'error', message: data.message || 'Unable to close session.' };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return { status: 'unavailable', message: 'Unable to close session due to network error.' };
  }
}

// ────────────────────────────────────────────────────────────
// Visitor Messaging (Phase 3.3)
// ────────────────────────────────────────────────────────────

export async function sendVisitorMessage(sessionId, credential, body, clientMessageId = null, { signal } = {}) {
  if (!sessionId || !credential) {
    return { status: 'invalid', message: 'Session ID and visitor credential are required.' };
  }
  if (!body || typeof body !== 'string' || !body.trim()) {
    return { status: 'invalid', message: 'Message body cannot be empty.' };
  }

  try {
    const payload = { body: body.trim() };
    if (clientMessageId) payload.clientMessageId = clientMessageId;

    const res = await fetch(`${SESSIONS_BASE}/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Visitor-Credential': credential,
      },
      body: JSON.stringify(payload),
      signal,
    });

    const data = await res.json().catch(() => ({}));

    if ((res.status === 201 || res.status === 200) && data.status === 'sent') {
      return {
        status: 'sent',
        message: data.message,
      };
    }

    if (res.status === 400 && (data.status === 'closed' || data.status === 'expired')) {
      return {
        status: data.status,
        message: data.message || `Session is ${data.status} and cannot accept messages.`,
      };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        status: 'unauthorized',
        message: data.message || 'Unauthorized session access.',
      };
    }

    if (res.status === 429) {
      return {
        status: 'rate_limited',
        message: data.message || 'Too many messages sent. Please wait a moment.',
      };
    }

    return {
      status: 'error',
      message: data.message || 'Unable to send message.',
    };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return {
      status: 'unavailable',
      message: 'Unable to send message due to network error.',
    };
  }
}

export async function fetchVisitorMessages(sessionId, credential, { after = 0, limit = 50, signal } = {}) {
  if (!sessionId || !credential) {
    return { status: 'invalid', message: 'Session ID and visitor credential are required.', messages: [] };
  }

  try {
    const params = new URLSearchParams();
    if (after) params.append('after', String(after));
    if (limit) params.append('limit', String(limit));

    const queryStr = params.toString() ? `?${params.toString()}` : '';
    const res = await fetch(`${SESSIONS_BASE}/${encodeURIComponent(sessionId)}/messages${queryStr}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Visitor-Credential': credential,
      },
      signal,
    });

    const data = await res.json().catch(() => ({}));

    if (res.status === 200) {
      return {
        status: 'ok',
        sessionId: data.sessionId,
        messages: Array.isArray(data.messages) ? data.messages : [],
        hasMore: Boolean(data.hasMore),
      };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        status: 'unauthorized',
        message: data.message || 'Unauthorized to access messages.',
        messages: [],
      };
    }

    return {
      status: 'error',
      message: data.message || 'Unable to fetch messages.',
      messages: [],
    };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return {
      status: 'unavailable',
      message: 'Unable to fetch messages due to network error.',
      messages: [],
    };
  }
}
