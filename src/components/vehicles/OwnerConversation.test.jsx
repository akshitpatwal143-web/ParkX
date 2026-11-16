// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent, act } from '@testing-library/react';

vi.mock('../../services/vehicleService', () => ({
  fetchOwnerSessionMessages: vi.fn(),
  sendOwnerReply: vi.fn(),
  acceptVisitorSession: vi.fn(),
  closeOwnerVisitorSession: vi.fn(),
}));

import {
  fetchOwnerSessionMessages,
  sendOwnerReply,
  acceptVisitorSession,
  closeOwnerVisitorSession,
} from '../../services/vehicleService';
import OwnerConversationModal from './OwnerConversationModal';

describe('OwnerConversationModal — Phase 3.3 Visitor–Owner Messaging', () => {
  const mockSession = {
    sessionId: 'vs_test_modal_1234567890123456',
    vehicleId: 101,
    status: 'pending',
    createdAt: '2026-03-01T12:00:00.000Z',
    expiresAt: '2026-03-02T12:00:00.000Z',
    messageCount: 1,
    lastMessagePreview: 'Visitor alert: your headlights are on',
  };

  const initialMessages = [
    {
      id: 1,
      senderType: 'visitor',
      body: 'Visitor alert: your headlights are on',
      createdAt: '2026-03-01T12:00:05.000Z',
    },
  ];

  beforeEach(() => {
    fetchOwnerSessionMessages.mockResolvedValue({
      status: 'ok',
      messages: initialMessages,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders conversation modal with visitor message in chronological order', async () => {
    render(
      <OwnerConversationModal
        session={mockSession}
        vehicleName="Porsche Taycan"
        onClose={() => {}}
        onSessionUpdated={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Visitor alert: your headlights are on')).toBeTruthy();
      expect(screen.getByText('Visitor')).toBeTruthy();
      expect(screen.getByPlaceholderText(/Type a reply to the visitor/i)).toBeTruthy();
    });
  });

  it('allows owner to send a reply immediately even when session is pending', async () => {
    sendOwnerReply.mockResolvedValueOnce({
      status: 'sent',
      message: {
        id: 2,
        senderType: 'owner',
        body: 'Thank you! Coming down to turn them off.',
        createdAt: '2026-03-01T12:01:00.000Z',
      },
    });

    render(
      <OwnerConversationModal
        session={mockSession}
        vehicleName="Porsche Taycan"
        onClose={() => {}}
        onSessionUpdated={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Type a reply to the visitor/i)).toBeTruthy();
    });

    const textarea = screen.getByPlaceholderText(/Type a reply to the visitor/i);
    const sendBtn = screen.getByRole('button', { name: /^Reply$/i });

    // Disabled initially when empty
    expect(sendBtn.hasAttribute('disabled')).toBe(true);

    // Type reply
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Thank you! Coming down to turn them off.' } });
    });

    expect(sendBtn.hasAttribute('disabled')).toBe(false);

    // Click reply
    await act(async () => {
      fireEvent.click(sendBtn);
    });

    await waitFor(() => {
      expect(sendOwnerReply).toHaveBeenCalledWith(
        mockSession.sessionId,
        'Thank you! Coming down to turn them off.',
        expect.any(String)
      );
      expect(screen.getByText('Thank you! Coming down to turn them off.')).toBeTruthy();
      expect(screen.getByText('You (Owner)')).toBeTruthy();
    });
  });

  it('allows owner to accept session from within conversation modal', async () => {
    const onSessionUpdated = vi.fn();
    acceptVisitorSession.mockResolvedValueOnce({
      status: 'accepted',
      sessionId: mockSession.sessionId,
      acceptedAt: new Date().toISOString(),
    });

    render(
      <OwnerConversationModal
        session={mockSession}
        vehicleName="Porsche Taycan"
        onClose={() => {}}
        onSessionUpdated={onSessionUpdated}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Accept$/i })).toBeTruthy();
    });

    const acceptBtn = screen.getByRole('button', { name: /^Accept$/i });
    await act(async () => {
      fireEvent.click(acceptBtn);
    });

    await waitFor(() => {
      expect(acceptVisitorSession).toHaveBeenCalledWith(mockSession.sessionId);
      expect(onSessionUpdated).toHaveBeenCalledWith(expect.objectContaining({ status: 'accepted' }));
    });
  });

  it('allows owner to close session from within conversation modal', async () => {
    const onSessionUpdated = vi.fn();
    closeOwnerVisitorSession.mockResolvedValueOnce({
      status: 'closed',
      sessionId: mockSession.sessionId,
      closedAt: new Date().toISOString(),
    });

    render(
      <OwnerConversationModal
        session={mockSession}
        vehicleName="Porsche Taycan"
        onClose={() => {}}
        onSessionUpdated={onSessionUpdated}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Close Session$/i })).toBeTruthy();
    });

    const closeBtn = screen.getByRole('button', { name: /^Close Session$/i });
    await act(async () => {
      fireEvent.click(closeBtn);
    });

    await waitFor(() => {
      expect(closeOwnerVisitorSession).toHaveBeenCalledWith(mockSession.sessionId);
      expect(onSessionUpdated).toHaveBeenCalledWith(expect.objectContaining({ status: 'closed' }));
    });
  });
});
