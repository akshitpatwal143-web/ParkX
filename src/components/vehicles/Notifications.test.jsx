// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../../services/vehicleService', () => ({
  fetchVehicles: vi.fn(),
  fetchOwnerSessions: vi.fn(),
  fetchOwnerSessionMessages: vi.fn(),
  acceptVisitorSession: vi.fn(),
  closeOwnerVisitorSession: vi.fn(),
  sendOwnerReply: vi.fn(),
  fetchNotifications: vi.fn(),
  markSessionAsRead: vi.fn(),
}));

vi.mock('../../services/notificationService', () => ({
  isPushSupported: vi.fn(),
  getNotificationPermission: vi.fn(),
  getPushStatus: vi.fn(),
  subscribeToPushNotifications: vi.fn(),
  unsubscribeFromPushNotifications: vi.fn(),
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, email: 'owner@example.com', fullName: 'Fleet Owner' },
    openLogin: vi.fn(),
    openSignup: vi.fn(),
    logout: vi.fn(),
    isInitializing: false,
    authError: null,
  }),
}));

import {
  fetchVehicles,
  fetchOwnerSessions,
  fetchOwnerSessionMessages,
  fetchNotifications,
  markSessionAsRead,
} from '../../services/vehicleService';

import {
  isPushSupported,
  getNotificationPermission,
  getPushStatus,
  subscribeToPushNotifications,
  unsubscribeFromPushNotifications,
} from '../../services/notificationService';

import Vehicles from './Vehicles';
import OwnerConversationModal from './OwnerConversationModal';
import Navbar from '../Navbar';

describe('Phase 3.4 — Notifications and Unread Message Tracking', () => {
  const sampleSessions = [
    {
      sessionId: 'vs_000000000000000000000000000000000000000000000001',
      vehicleId: 10,
      status: 'pending',
      createdAt: '2026-03-01T12:00:00.000Z',
      expiresAt: '2026-03-02T12:00:00.000Z',
      messageCount: 3,
      unreadCount: 2,
      vehicle: {
        id: 10,
        registrationNumber: 'PX-100',
        vehicleModel: 'Tesla Model S',
        vehicleType: 'car',
        color: 'Midnight Silver',
      },
      lastMessage: {
        body: 'Car parked too close',
        senderType: 'visitor',
        createdAt: '2026-03-01T12:05:00.000Z',
      },
    },
  ];

  beforeEach(() => {
    fetchVehicles.mockResolvedValue({ vehicles: [] });
    fetchOwnerSessions.mockResolvedValue({ sessions: sampleSessions });
    fetchOwnerSessionMessages.mockResolvedValue({
      messages: [
        { id: 1, senderType: 'visitor', body: 'Car parked too close', createdAt: '2026-03-01T12:05:00.000Z' },
      ],
    });
    fetchNotifications.mockResolvedValue({
      totalUnreadCount: 2,
      sessions: [
        {
          sessionId: sampleSessions[0].sessionId,
          vehicleId: 10,
          registrationNumber: 'PX-100',
          vehicleModel: 'Tesla Model S',
          unreadCount: 2,
          lastMessageAt: '2026-03-01T12:05:00.000Z',
        },
      ],
    });
    markSessionAsRead.mockResolvedValue({
      status: 'ok',
      sessionId: sampleSessions[0].sessionId,
      unreadCount: 0,
    });
    isPushSupported.mockReturnValue(true);
    getNotificationPermission.mockReturnValue('default');
    getPushStatus.mockResolvedValue({ subscribed: false, vapidPublicKey: 'test-key' });
    subscribeToPushNotifications.mockResolvedValue({ status: 'subscribed' });
    unsubscribeFromPushNotifications.mockResolvedValue({ status: 'unsubscribed' });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders unread message badge on tab header and session card', async () => {
    render(<Vehicles />);

    // Switch to requests tab
    const requestsTab = await screen.findByRole('button', { name: /contact requests/i });
    expect(requestsTab).toBeDefined();

    // The tab header displays the unread badge
    expect(await screen.findByText(/2 unread/i)).toBeDefined();

    fireEvent.click(requestsTab);

    // Session card renders unread badge
    expect(await screen.findByText(/2 NEW/i)).toBeDefined();
  });

  it('automatically marks conversation as read when modal opens', async () => {
    render(
      <OwnerConversationModal
        sessionId={sampleSessions[0].sessionId}
        session={sampleSessions[0]}
        onClose={vi.fn()}
        onSessionUpdated={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(markSessionAsRead).toHaveBeenCalledWith(sampleSessions[0].sessionId);
    });
  });

  it('notification settings toggle allows enabling and disabling push notifications', async () => {
    render(<Vehicles />);

    const requestsTab = await screen.findByRole('button', { name: /contact requests/i });
    fireEvent.click(requestsTab);

    // Initial state: Notifications not enabled, button says Enable Notifications
    const enableBtn = await screen.findByRole('button', { name: /enable notifications/i });
    expect(enableBtn).toBeDefined();

    // Click Enable Notifications
    fireEvent.click(enableBtn);

    await waitFor(() => {
      expect(subscribeToPushNotifications).toHaveBeenCalled();
    });

    // After enabling, button switches to Disable
    const disableBtn = await screen.findByRole('button', { name: /disable/i });
    expect(disableBtn).toBeDefined();

    // Click Disable
    fireEvent.click(disableBtn);

    await waitFor(() => {
      expect(unsubscribeFromPushNotifications).toHaveBeenCalled();
    });
  });

  it('Navbar notification bell shows unread count badge and opens dropdown', async () => {
    const onNavigateView = vi.fn();
    render(<Navbar currentView="garage" onNavigateView={onNavigateView} />);

    // Notification bell button has the unread count badge (2)
    const bellBtn = await screen.findByRole('button', { name: /view notifications/i });
    expect(bellBtn).toBeDefined();
    const badges = await screen.findAllByText('2');
    expect(badges.length).toBeGreaterThan(0);

    // Click bell button to open dropdown
    fireEvent.click(bellBtn);

    // Dropdown shows vehicle and unread count
    expect(await screen.findByText(/Tesla Model S \(PX-100\)/i)).toBeDefined();
    expect(await screen.findByText(/2 new/i)).toBeDefined();

    // Click notification item to navigate to conversation
    const itemBtn = screen.getByText(/Tesla Model S \(PX-100\)/i).closest('button');
    fireEvent.click(itemBtn);

    expect(onNavigateView).toHaveBeenCalledWith('garage', {
      openSessionId: sampleSessions[0].sessionId,
    });
  });
});
