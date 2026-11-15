// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent, act } from '@testing-library/react';

vi.mock('../../services/vehicleService', () => ({
  fetchVehicle: vi.fn(),
  updateVehicle: vi.fn(),
  deleteVehicle: vi.fn(),
  rotateQrCode: vi.fn(),
  fetchVehicleSessions: vi.fn(),
  acceptVisitorSession: vi.fn(),
  closeOwnerVisitorSession: vi.fn(),
}));

import {
  fetchVehicle,
  fetchVehicleSessions,
  acceptVisitorSession,
  closeOwnerVisitorSession,
} from '../../services/vehicleService';
import VehicleDetails from './VehicleDetails';

describe('VehicleDetails — Owner Visitor Contact Requests (Phase 3.2)', () => {
  const vehicleDetails = {
    vehicle: {
      id: 55,
      registrationNumber: 'PX-55',
      vehicleType: 'car',
      vehicleModel: 'BMW i4',
      color: 'San Remo Green',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    qrHistory: [],
  };

  const mockSessions = [
    {
      sessionId: 'vs_session_pending_1234567890123456',
      vehicleId: 55,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    },
  ];

  beforeEach(() => {
    fetchVehicle.mockResolvedValue(vehicleDetails);
    fetchVehicleSessions.mockResolvedValue({ sessions: mockSessions });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('displays incoming visitor contact requests for the vehicle', async () => {
    render(<VehicleDetails vehicleId={55} onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Incoming Contact Requests')).toBeTruthy();
      expect(screen.getByText(/1 Session\(s\)/i)).toBeTruthy();
      expect(screen.getByText('pending')).toBeTruthy();
      expect(screen.getByRole('button', { name: /Accept Request/i })).toBeTruthy();
      expect(screen.getByRole('button', { name: /Close/i })).toBeTruthy();
    });
  });

  it('allows owner to accept a pending visitor contact request', async () => {
    acceptVisitorSession.mockResolvedValueOnce({
      status: 'accepted',
      sessionId: 'vs_session_pending_1234567890123456',
      acceptedAt: new Date().toISOString(),
    });

    render(<VehicleDetails vehicleId={55} onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Accept Request/i })).toBeTruthy();
    });

    const acceptBtn = screen.getByRole('button', { name: /Accept Request/i });
    await act(async () => {
      fireEvent.click(acceptBtn);
    });

    await waitFor(() => {
      expect(acceptVisitorSession).toHaveBeenCalledWith('vs_session_pending_1234567890123456');
      expect(screen.getByText('accepted')).toBeTruthy();
    });
  });

  it('allows owner to close a visitor contact session', async () => {
    closeOwnerVisitorSession.mockResolvedValueOnce({
      status: 'closed',
      sessionId: 'vs_session_pending_1234567890123456',
      closedAt: new Date().toISOString(),
    });

    render(<VehicleDetails vehicleId={55} onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Close/i })).toBeTruthy();
    });

    const closeBtn = screen.getByRole('button', { name: /Close/i });
    await act(async () => {
      fireEvent.click(closeBtn);
    });

    await waitFor(() => {
      expect(closeOwnerVisitorSession).toHaveBeenCalledWith('vs_session_pending_1234567890123456');
      expect(screen.getByText('closed')).toBeTruthy();
    });
  });
});
