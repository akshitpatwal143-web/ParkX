// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, act } from '@testing-library/react';

vi.mock('../../services/publicService', () => ({
  verifyPublicToken: vi.fn(),
}));

import { verifyPublicToken } from '../../services/publicService';
import PublicVehicleView from './PublicVehicleView';
import { isVisitorPath, syncThirdPartyFontPolicy } from '../../App';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('PublicVehicleView — Stale Async Response Prevention', () => {
  const tokenA = 'pkx_' + 'a'.repeat(64);
  const tokenB = 'pkx_' + 'b'.repeat(64);

  const vehicleA = {
    vehicleModel: 'Porsche Taycan 4S',
    vehicleType: 'ev',
    color: 'Frozen Blue',
  };

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('Ordering 1: resolves B first, then late A resolves — UI shows B and never shows A', async () => {
    const deferredA = deferred();
    const deferredB = deferred();

    verifyPublicToken.mockImplementation((tok) => {
      if (tok === tokenA) return deferredA.promise;
      if (tok === tokenB) return deferredB.promise;
      return Promise.resolve({ status: 'invalid', message: 'Unexpected' });
    });

    // 1. Mount with valid token A
    const { rerender } = render(<PublicVehicleView token={tokenA} onNavigateHome={() => {}} />);
    expect(screen.getByText(/Verifying Vehicle Pass/i)).toBeTruthy();

    // 2. Navigate to invalid token B before A resolves
    rerender(<PublicVehicleView token={tokenB} onNavigateHome={() => {}} />);

    // 3. Resolve B first (invalid)
    await act(async () => {
      deferredB.resolve({ status: 'invalid', message: 'Token B is invalid' });
    });

    // B's invalid state must now be visible
    await waitFor(() => {
      expect(screen.getByText(/Invalid QR Pass/i)).toBeTruthy();
      expect(screen.getByText(/Token B is invalid/i)).toBeTruthy();
    });

    // 4. Resolve A afterward (valid vehicle)
    await act(async () => {
      deferredA.resolve({ status: 'valid', vehicle: vehicleA });
    });

    // Assert: UI still displays B's invalid state and NEVER displays A's vehicle
    expect(screen.getByText(/Invalid QR Pass/i)).toBeTruthy();
    expect(screen.queryByText(/Porsche Taycan 4S/i)).toBeNull();
    expect(screen.queryByText(/Frozen Blue/i)).toBeNull();
  });

  it('Ordering 2: resolves A first, then B resolves — UI shows B and never shows A', async () => {
    const deferredA = deferred();
    const deferredB = deferred();

    verifyPublicToken.mockImplementation((tok) => {
      if (tok === tokenA) return deferredA.promise;
      if (tok === tokenB) return deferredB.promise;
      return Promise.resolve({ status: 'invalid', message: 'Unexpected' });
    });

    // 1. Mount with valid token A
    const { rerender } = render(<PublicVehicleView token={tokenA} onNavigateHome={() => {}} />);
    expect(screen.getByText(/Verifying Vehicle Pass/i)).toBeTruthy();

    // 2. Navigate to invalid token B before A resolves
    rerender(<PublicVehicleView token={tokenB} onNavigateHome={() => {}} />);

    // 3. Resolve A first (stale response for A arrives while B is pending)
    await act(async () => {
      deferredA.resolve({ status: 'valid', vehicle: vehicleA });
    });

    // Verify A was ignored: UI must NOT show Porsche Taycan 4S
    expect(screen.queryByText(/Porsche Taycan 4S/i)).toBeNull();
    expect(screen.getByText(/Verifying Vehicle Pass/i)).toBeTruthy();

    // 4. Resolve B (invalid)
    await act(async () => {
      deferredB.resolve({ status: 'invalid', message: 'Token B is invalid' });
    });

    // Assert: UI shows B's invalid state
    await waitFor(() => {
      expect(screen.getByText(/Invalid QR Pass/i)).toBeTruthy();
      expect(screen.getByText(/Token B is invalid/i)).toBeTruthy();
    });
    expect(screen.queryByText(/Porsche Taycan 4S/i)).toBeNull();
  });

  it('aborts pending fetch requests when the component unmounts', () => {
    let capturedSignal = null;
    verifyPublicToken.mockImplementation((_tok, { signal } = {}) => {
      capturedSignal = signal;
      return new Promise(() => {}); // never resolves
    });

    const { unmount } = render(<PublicVehicleView token={tokenA} onNavigateHome={() => {}} />);
    expect(capturedSignal).toBeTruthy();
    expect(capturedSignal.aborted).toBe(false);

    unmount();
    expect(capturedSignal.aborted).toBe(true);
  });

  it('immediately clears and hides vehicle A when token prop switches to B, displaying loading before B resolves', async () => {
    const deferredA = deferred();
    const deferredB = deferred();

    verifyPublicToken.mockImplementation((tok) => {
      if (tok === tokenA) return deferredA.promise;
      if (tok === tokenB) return deferredB.promise;
      return Promise.resolve({ status: 'invalid', message: 'Unexpected' });
    });

    // 1. Render component with valid token A
    const { rerender } = render(<PublicVehicleView token={tokenA} onNavigateHome={() => {}} />);

    // 2. Resolve verification A and confirm vehicle A is displayed
    await act(async () => {
      deferredA.resolve({ status: 'valid', vehicle: vehicleA });
    });

    await waitFor(() => {
      expect(screen.getByText(/Porsche Taycan 4S/i)).toBeTruthy();
      expect(screen.getByText(/Frozen Blue/i)).toBeTruthy();
      expect(screen.getByText(/VERIFIED PASS/i)).toBeTruthy();
    });

    // 3. Change the token prop to B
    rerender(<PublicVehicleView token={tokenB} onNavigateHome={() => {}} />);

    // 4. Before resolving verification B, assert that vehicle A is immediately absent
    expect(screen.queryByText(/Porsche Taycan 4S/i)).toBeNull();
    expect(screen.queryByText(/Frozen Blue/i)).toBeNull();
    expect(screen.queryByText(/VERIFIED PASS/i)).toBeNull();

    // 5. Assert that the loading state is displayed
    expect(screen.getByText(/Verifying Vehicle Pass/i)).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();

    // 6. Resolve B and verify that only B's result is shown
    await act(async () => {
      deferredB.resolve({ status: 'invalid', message: 'QR pass for vehicle B not found' });
    });

    await waitFor(() => {
      expect(screen.getByText(/Invalid QR Pass/i)).toBeTruthy();
      expect(screen.getByText(/QR pass for vehicle B not found/i)).toBeTruthy();
    });
    expect(screen.queryByText(/Porsche Taycan 4S/i)).toBeNull();
    expect(screen.queryByText(/Verifying Vehicle Pass/i)).toBeNull();
  });
});

describe('Third-party Font Request Suppression for Visitor Paths', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
  });

  afterEach(() => {
    document.head.innerHTML = '';
  });

  it('isVisitorPath matches canonical and noncanonical / malformed visitor URLs', () => {
    expect(isVisitorPath('/v/pkx_12345')).toBe(true);
    expect(isVisitorPath('/v/pkx_12345/extra')).toBe(true);
    expect(isVisitorPath('/v/pkx_12345/extra/path/segments')).toBe(true);
    expect(isVisitorPath('/v/')).toBe(true);
    expect(isVisitorPath('/v')).toBe(true);

    // Non-visitor paths
    expect(isVisitorPath('/')).toBe(false);
    expect(isVisitorPath('/vehicles')).toBe(false);
    expect(isVisitorPath('/vehicles/new')).toBe(false);
  });

  it('syncThirdPartyFontPolicy removes Google Fonts on noncanonical visitor paths and restores on landing', () => {
    // Simulate landing page having loaded Google Fonts
    const fontLink = document.createElement('link');
    fontLink.rel = 'stylesheet';
    fontLink.href = 'https://fonts.googleapis.com/css2?family=Inter&display=swap';
    document.head.appendChild(fontLink);
    expect(document.querySelector('link[href*="fonts.googleapis.com"]')).toBeTruthy();

    // Navigate to malformed visitor path: /v/pkx_123/extra
    syncThirdPartyFontPolicy('/v/pkx_123/extra');
    expect(document.querySelector('link[href*="fonts.googleapis.com"]')).toBeNull();

    // Navigate to landing: /
    syncThirdPartyFontPolicy('/');
    expect(document.querySelector('link[href*="fonts.googleapis.com"]')).toBeTruthy();
  });
});
