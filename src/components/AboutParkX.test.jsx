// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import AboutParkX from './AboutParkX';

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    openSignup: vi.fn(),
  }),
}));

describe('AboutParkX Component', () => {
  beforeEach(() => {
    class MockIntersectionObserver {
      constructor(callback) {
        this.callback = callback;
      }
      observe() {
        this.callback([{ isIntersecting: true }]);
      }
      unobserve() {}
      disconnect() {}
    }
    window.IntersectionObserver = MockIntersectionObserver;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders heading "Parking problems? Sorted."', () => {
    render(<AboutParkX />);
    expect(screen.getByRole('heading', { level: 2, name: /Parking problems\? Sorted\./i })).toBeTruthy();
  });

  it('renders description with core value proposition', () => {
    render(<AboutParkX />);
    expect(
      screen.getByText(/ParkX connects vehicle owners and visitors through a simple QR code/i)
    ).toBeTruthy();
  });

  it('renders all three key highlights', () => {
    render(<AboutParkX />);
    expect(screen.getByText('Smart Priority Alerts')).toBeTruthy();
    expect(screen.getByText('Owner Availability')).toBeTruthy();
    expect(screen.getByText('Instant Communication')).toBeTruthy();
  });

  it('calls onGetStarted when action button is clicked', () => {
    const handleGetStarted = vi.fn();
    render(<AboutParkX onGetStarted={handleGetStarted} />);
    const button = screen.getByRole('button', { name: /Get Your Vehicle QR Pass/i });
    fireEvent.click(button);
    expect(handleGetStarted).toHaveBeenCalledTimes(1);
  });

  it('respects prefers-reduced-motion media query', () => {
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    render(<AboutParkX />);
    const heading = screen.getByRole('heading', { level: 2, name: /Parking problems\? Sorted\./i });
    expect(heading.style.transform).toBe('none');
    expect(heading.style.opacity).toBe('1');
  });
});
