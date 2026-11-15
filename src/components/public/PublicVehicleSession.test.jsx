// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent, act } from '@testing-library/react';

vi.mock('../../services/publicService', () => ({
  verifyPublicToken: vi.fn(),
  getStoredVisitorSession: vi.fn(),
  saveStoredVisitorSession: vi.fn(),
  clearStoredVisitorSession: vi.fn(),
  createVisitorSession: vi.fn(),
  getVisitorSession: vi.fn(),
  closeVisitorSession: vi.fn(),
}));

import {
  verifyPublicToken,
  getStoredVisitorSession,
  saveStoredVisitorSession,
  clearStoredVisitorSession,
  createVisitorSession,
  getVisitorSession,
  closeVisitorSession,
} from '../../services/publicService';
import PublicVehicleView from './PublicVehicleView';

describe('PublicVehicleView — Anonymous Visitor Sessions (Phase 3.2)', () => {
  const testToken = 'pkx_' + '7'.repeat(64);
  const testVehicle = {
    vehicleModel: 'Porsche Taycan 4S',
    vehicleType: 'ev',
    color: 'Frozen Blue',
  };

  beforeEach(() => {
    getStoredVisitorSession.mockReturnValue(null);
    verifyPublicToken.mockResolvedValue({
      status: 'valid',
      vehicle: testVehicle,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders "Contact Vehicle Owner" action when vehicle pass is verified', async () => {
    render(<PublicVehicleView token={testToken} onNavigateHome={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/Target Vehicle Specifications/i)).toBeTruthy();
      expect(screen.getByText('Porsche Taycan 4S')).toBeTruthy();
    });

    const contactBtn = screen.getByRole('button', { name: /Contact Vehicle Owner/i });
    expect(contactBtn).toBeTruthy();
    expect(screen.getByText(/The owner never sees your identity/i)).toBeTruthy();
  });

  it('initiates a visitor contact session on click and displays pending status', async () => {
    createVisitorSession.mockResolvedValueOnce({
      status: 'pending',
      sessionId: 'vs_test_session_12345678901234567890',
      visitorCredential: 'vcred_' + 'a'.repeat(64),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });

    render(<PublicVehicleView token={testToken} onNavigateHome={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Contact Vehicle Owner/i })).toBeTruthy();
    });

    const contactBtn = screen.getByRole('button', { name: /Contact Vehicle Owner/i });
    await act(async () => {
      fireEvent.click(contactBtn);
    });

    await waitFor(() => {
      expect(createVisitorSession).toHaveBeenCalledWith(testToken);
      expect(screen.getByText(/Contact Request Pending/i)).toBeTruthy();
      expect(screen.getByText(/Your contact notification has been dispatched/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: /Close Contact Session/i })).toBeTruthy();
    });
  });

  it('displays rate limiting or server error message when session creation fails', async () => {
    createVisitorSession.mockResolvedValueOnce({
      status: 'rate_limited',
      message: 'Too many contact requests created. Please wait before trying again.',
    });

    render(<PublicVehicleView token={testToken} onNavigateHome={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Contact Vehicle Owner/i })).toBeTruthy();
    });

    const contactBtn = screen.getByRole('button', { name: /Contact Vehicle Owner/i });
    await act(async () => {
      fireEvent.click(contactBtn);
    });

    await waitFor(() => {
      expect(screen.getByText(/Too many contact requests created/i)).toBeTruthy();
    });
  });

  it('resumes an existing active visitor session from storage', async () => {
    const storedSession = {
      sessionId: 'vs_existing_stored_session_123456789',
      visitorCredential: 'vcred_' + 'e'.repeat(64),
      status: 'pending',
      expiresAt: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
    };
    getStoredVisitorSession.mockReturnValueOnce(storedSession);
    getVisitorSession.mockResolvedValueOnce({
      status: 'accepted',
      sessionId: storedSession.sessionId,
      expiresAt: storedSession.expiresAt,
    });

    render(<PublicVehicleView token={testToken} onNavigateHome={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/Contact Request Accepted/i)).toBeTruthy();
      expect(screen.getByText(/The vehicle owner has accepted your contact request/i)).toBeTruthy();
    });
  });

  it('allows the visitor to close an active contact session', async () => {
    const storedSession = {
      sessionId: 'vs_to_close_12345678901234567890',
      visitorCredential: 'vcred_' + 'c'.repeat(64),
      status: 'pending',
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    };
    getStoredVisitorSession.mockReturnValueOnce(storedSession);
    getVisitorSession.mockResolvedValueOnce({
      status: 'pending',
      sessionId: storedSession.sessionId,
      expiresAt: storedSession.expiresAt,
    });
    closeVisitorSession.mockResolvedValueOnce({
      status: 'closed',
      closedAt: new Date().toISOString(),
    });

    render(<PublicVehicleView token={testToken} onNavigateHome={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Close Contact Session/i })).toBeTruthy();
    });

    const closeBtn = screen.getByRole('button', { name: /Close Contact Session/i });
    await act(async () => {
      fireEvent.click(closeBtn);
    });

    await waitFor(() => {
      expect(closeVisitorSession).toHaveBeenCalledWith(storedSession.sessionId, storedSession.visitorCredential);
      expect(clearStoredVisitorSession).toHaveBeenCalledWith(testToken);
      expect(screen.getByText(/Contact Session Closed/i)).toBeTruthy();
    });
  });

  it('prevents stale polling responses from overwriting a newer closed session state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const storedSession = {
        sessionId: 'vs_stale_poll_test_12345',
        visitorCredential: 'vcred_' + 's'.repeat(64),
        status: 'pending',
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      };
      getStoredVisitorSession.mockReturnValue(storedSession);

      let resolveLatePoll;
      const latePollPromise = new Promise((resolve) => {
        resolveLatePoll = resolve;
      });

      // getVisitorSession returns a deferred promise on polling
      getVisitorSession.mockImplementation(() => latePollPromise);

      closeVisitorSession.mockResolvedValueOnce({
        status: 'closed',
        closedAt: new Date().toISOString(),
      });

      render(<PublicVehicleView token={testToken} onNavigateHome={() => {}} />);

      // Advance timers by 8 seconds to trigger polling interval
      await act(async () => {
        vi.advanceTimersByTime(8000);
      });

      // Now visitor clicks Close Session while the poll request is still in-flight
      const closeBtn = screen.getByRole('button', { name: /Close Contact Session/i });
      await act(async () => {
        fireEvent.click(closeBtn);
      });

      // Session is now closed in state
      expect(screen.getByText(/Contact Session Closed/i)).toBeTruthy();

      // Now the late polling promise resolves with old pending/accepted data
      await act(async () => {
        resolveLatePoll({
          status: 'accepted',
          sessionId: storedSession.sessionId,
          expiresAt: storedSession.expiresAt,
        });
      });

      // Crucial assertion: Stale response was dropped, status remains Closed!
      expect(screen.getByText(/Contact Session Closed/i)).toBeTruthy();
      expect(screen.queryByText(/Contact Request Accepted/i)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up and aborts polling controllers upon unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const storedSession = {
        sessionId: 'vs_unmount_test_12345',
        visitorCredential: 'vcred_' + 'u'.repeat(64),
        status: 'pending',
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      };
      getStoredVisitorSession.mockReturnValue(storedSession);
      getVisitorSession.mockResolvedValue({
        status: 'pending',
        sessionId: storedSession.sessionId,
      });

      const { unmount } = render(<PublicVehicleView token={testToken} onNavigateHome={() => {}} />);

      // Advance time to start interval
      await act(async () => {
        vi.advanceTimersByTime(8000);
      });

      expect(getVisitorSession).toHaveBeenCalled();

      // Unmount component
      unmount();

      // Clear mock call count
      getVisitorSession.mockClear();

      // Advance time further after unmount
      await act(async () => {
        vi.advanceTimersByTime(16000);
      });

      // No new polling calls should occur after unmount
      expect(getVisitorSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
