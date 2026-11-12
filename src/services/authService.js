/** Same-origin API client for the session-based authentication endpoints. */
const API_BASE = '/api/auth';

async function readResponse(res, fallback) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.message || fallback);
    error.status = res.status;
    throw error;
  }
  return data;
}

export async function csrfToken() {
  const res = await fetch(`${API_BASE}/csrf`, { method: 'GET', credentials: 'include' });
  const data = await readResponse(res, 'Unable to prepare a secure request');
  if (typeof data.csrfToken !== 'string' || !data.csrfToken) throw new Error('Unable to prepare a secure request');
  return data.csrfToken;
}

async function post(path, body) {
  const token = await csrfToken();
  const res = await fetch(`${API_BASE}/${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return readResponse(res, `${path} failed`);
}

export async function login({ email, password }) {
  return post('login', { email, password });
}

export async function signup({ name, email, password }) {
  return post('signup', { name, email, password });
}

export async function logout() {
  return post('logout');
}

export async function getMe() {
  const res = await fetch(`${API_BASE}/me`, { method: 'GET', credentials: 'include' });
  if (res.status === 401) return { user: null };
  return readResponse(res, 'Unable to restore your ParkX session');
}
