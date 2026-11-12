// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/vehicleService', () => ({
  updateVehicle: vi.fn(),
  deleteVehicle: vi.fn(),
  rotateQrCode: vi.fn(),
  fetchVehicle: vi.fn(),
}));

import { fetchVehicle } from '../../services/vehicleService';
import VehicleDetails from './VehicleDetails';

const details = {
  vehicle: {
    id: 41,
    registrationNumber: 'PX-41',
    vehicleType: 'car',
    vehicleModel: 'Test Model',
    color: 'Black',
    createdAt: '2026-01-01T00:00:00.000Z',
    qrCode: { id: 7, status: 'active' },
  },
  qrHistory: [{ id: 7, status: 'active', created_at: '2026-01-01T00:00:00.000Z' }],
};

describe('VehicleDetails QR pass behavior', () => {
  beforeEach(() => {
    fetchVehicle.mockResolvedValue(details);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows a QR generated from the one-time issued token and keeps it through the details response', async () => {
    render(<VehicleDetails vehicleId={41} initialQrToken="pkx_genuine_one_time_token" onInitialQrTokenConsumed={() => {}} />);
    const image = await screen.findByRole('img', { name: 'QR code for PX-41' });
    const realPng = image.getAttribute('src');
    expect(realPng).toMatch(/^data:image\/png;base64,/);
    await waitFor(() => expect(fetchVehicle).toHaveBeenCalledWith(41));
    expect(screen.getByRole('img', { name: 'QR code for PX-41' }).getAttribute('src')).toBe(realPng);
  });

  it('after reload without the raw token shows no QR and instructs the owner to rotate', async () => {
    const first = render(<VehicleDetails vehicleId={41} initialQrToken="pkx_genuine_one_time_token" onInitialQrTokenConsumed={() => {}} />);
    await screen.findByRole('img', { name: 'QR code for PX-41' });
    first.unmount();

    render(<VehicleDetails vehicleId={41} onInitialQrTokenConsumed={() => {}} />);
    await screen.findByText('QR Issuance & Revocation History');
    expect(screen.queryByRole('img', { name: 'QR code for PX-41' })).toBeNull();
    expect(screen.getByText(/raw token is only available when issued.*Rotate the token to generate a new pass/i)).toBeTruthy();
    expect(screen.getByText('Pass unavailable')).toBeTruthy();
  });
});
