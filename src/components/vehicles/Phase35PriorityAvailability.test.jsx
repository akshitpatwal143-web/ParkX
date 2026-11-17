// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../../services/vehicleService', () => ({
  fetchOwnerSessionMessages: vi.fn(),
  sendOwnerReply: vi.fn(),
  acceptVisitorSession: vi.fn(),
  closeOwnerVisitorSession: vi.fn(),
  markSessionAsRead: vi.fn(),
  updateSessionPriority: vi.fn(),
  fetchOwnerAvailability: vi.fn(),
  updateOwnerAvailability: vi.fn(),
  fetchOwnerSessions: vi.fn(),
}));

import {
  fetchOwnerSessionMessages,
  markSessionAsRead,
  updateSessionPriority,
} from '../../services/vehicleService';
import OwnerConversationModal from './OwnerConversationModal';

describe('Phase 3.5 — Priority and Owner Availability UI Tests', () => {
  const mockSession = {
    sessionId: 'vs_test_phase35_123456789',
    vehicleId: 101,
    status: 'accepted',
    priority: 'urgent',
    priorityOverridden: false,
    createdAt: '2026-03-01T12:00:00.000Z',
    expiresAt: '2026-03-02T12:00:00.000Z',
    messageCount: 2,
    vehicle: {
      vehicleModel: 'Tesla Model 3',
      registrationNumber: 'DL01AB1234',
    },
  };

  const initialMessages = [
    {
      id: 1,
      senderType: 'visitor',
      body: 'Someone blocked your car and an ambulance needs to pass!',
      priority: 'urgent',
      priorityReason: 'Urgent obstruction involving emergency vehicle',
      createdAt: '2026-03-01T12:00:05.000Z',
    },
    {
      id: 2,
      senderType: 'owner',
      body: 'I am currently busy. I have received your message and will respond as soon as possible.',
      isAutoReply: true,
      createdAt: '2026-03-01T12:00:06.000Z',
    },
  ];

  beforeEach(() => {
    fetchOwnerSessionMessages.mockResolvedValue({
      status: 'ok',
      messages: initialMessages,
    });
    markSessionAsRead.mockResolvedValue({ status: 'ok' });
    updateSessionPriority.mockResolvedValue({ status: 'ok', priority: 'high', priorityOverridden: true });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders priority badge and auto-reply badge in conversation modal', async () => {
    render(
      <OwnerConversationModal
        session={mockSession}
        onClose={() => {}}
        onSessionUpdated={() => {}}
      />
    );

    await waitFor(() => {
      // Urgent priority badge in header
      const urgentBadges = screen.getAllByText(/urgent/i);
      expect(urgentBadges.length).toBeGreaterThan(0);

      // Auto-reply badge on owner auto message
      expect(screen.getByText(/Auto-reply/i)).toBeTruthy();

      // AI explanation on visitor message
      expect(screen.getByText(/Urgent obstruction involving emergency vehicle/i)).toBeTruthy();
    });
  });

  it('allows owner to override session priority', async () => {
    const handleUpdate = vi.fn();
    render(
      <OwnerConversationModal
        session={mockSession}
        onClose={() => {}}
        onSessionUpdated={handleUpdate}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/Priority:/i)).toBeTruthy();
    });

    const highBtn = screen.getByRole('button', { name: /^high$/i });
    fireEvent.click(highBtn);

    await waitFor(() => {
      expect(updateSessionPriority).toHaveBeenCalledWith('vs_test_phase35_123456789', 'high');
      expect(handleUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 'high',
          priorityOverridden: true,
        })
      );
    });
  });

  it('never displays AI intent label when message priority is Default priority', async () => {
    fetchOwnerSessionMessages.mockResolvedValueOnce({
      status: 'ok',
      messages: [
        {
          id: 1,
          senderType: 'visitor',
          body: 'Hello',
          priority: 'normal',
          priorityReason: 'Default priority',
          createdAt: '2026-03-01T12:00:05.000Z',
        },
      ],
    });

    render(
      <OwnerConversationModal
        session={mockSession}
        onClose={() => {}}
        onSessionUpdated={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Hello')).toBeTruthy();
      expect(screen.queryByText(/AI intent:/i)).toBeNull();
    });
  });
});
