import { csrfToken } from './authService';

const API_BASE = '/api/vehicles';

async function readResponse(res, fallback) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.message || fallback);
    error.status = res.status;
    error.errors = data.errors;
    throw error;
  }
  return data;
}

export async function fetchVehicles() {
  const res = await fetch(API_BASE, {
    method: 'GET',
    credentials: 'include',
  });
  return readResponse(res, 'Failed to fetch vehicles');
}

export async function fetchVehicle(id) {
  const res = await fetch(`${API_BASE}/${id}`, {
    method: 'GET',
    credentials: 'include',
  });
  return readResponse(res, 'Failed to fetch vehicle details');
}

export async function registerVehicle(vehicleData) {
  const token = await csrfToken();
  const res = await fetch(API_BASE, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
    },
    body: JSON.stringify(vehicleData),
  });
  return readResponse(res, 'Failed to register vehicle');
}

export async function updateVehicle(id, updates) {
  const token = await csrfToken();
  const res = await fetch(`${API_BASE}/${id}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
    },
    body: JSON.stringify(updates),
  });
  return readResponse(res, 'Failed to update vehicle');
}

export async function deleteVehicle(id) {
  const token = await csrfToken();
  const res = await fetch(`${API_BASE}/${id}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: {
      'X-CSRF-Token': token,
    },
  });
  return readResponse(res, 'Failed to delete vehicle');
}

export async function rotateQrCode(id) {
  const token = await csrfToken();
  const res = await fetch(`${API_BASE}/${id}/qr/rotate`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'X-CSRF-Token': token,
    },
  });
  return readResponse(res, 'Failed to rotate QR code');
}
