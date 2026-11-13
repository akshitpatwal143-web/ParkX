import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PUBLIC_FRONTEND_URL,
  normalizeBaseUrl,
  getPublicFrontendUrl,
  buildQrPayload,
  generateQrDataUrl,
  QR_TOKEN_UNAVAILABLE_MESSAGE,
} from './qrPass';

describe('qrPass service', () => {
  it('defines the canonical production Vercel base URL', () => {
    expect(DEFAULT_PUBLIC_FRONTEND_URL).toBe('https://park-x-flame.vercel.app');
  });

  it('normalizes base URLs by trimming whitespace and trailing slashes', () => {
    expect(normalizeBaseUrl('  https://park-x-flame.vercel.app///  ')).toBe('https://park-x-flame.vercel.app');
    expect(normalizeBaseUrl('https://custom.app/')).toBe('https://custom.app');
    expect(normalizeBaseUrl('')).toBe('');
    expect(normalizeBaseUrl(null)).toBe('');
    expect(normalizeBaseUrl(undefined)).toBe('');
  });

  it('builds QR payload with canonical domain and encoded token', () => {
    expect(buildQrPayload('pkx_standard_token')).toBe('https://park-x-flame.vercel.app/v/pkx_standard_token');
    expect(buildQrPayload('token with spaces & symbols/')).toBe(
      'https://park-x-flame.vercel.app/v/token%20with%20spaces%20%26%20symbols%2F'
    );
  });

  it('allows explicit base URL override for local dev or preview branches', () => {
    expect(buildQrPayload('token123', 'http://localhost:5173/')).toBe('http://localhost:5173/v/token123');
    expect(buildQrPayload('token123', 'https://parkx-preview.vercel.app')).toBe(
      'https://parkx-preview.vercel.app/v/token123'
    );
  });

  it('rejects empty or non-string tokens', () => {
    expect(() => buildQrPayload('')).toThrow('A newly issued QR token is required');
    expect(() => buildQrPayload(null)).toThrow('A newly issued QR token is required');
    expect(() => buildQrPayload(12345)).toThrow('A newly issued QR token is required');
    expect(QR_TOKEN_UNAVAILABLE_MESSAGE).toMatch(/Rotate the token/);
  });

  it('generates a real QR PNG data URL embedding the target URL', async () => {
    const png = await generateQrDataUrl('pkx_test_token');
    expect(png).toMatch(/^data:image\/png;base64,/);
  });

  it('passes the generated payload to custom encoder mock and respects baseUrl argument', async () => {
    let capturedPayload = '';
    const mockEncoder = {
      toDataURL: async (payload, options) => {
        capturedPayload = payload;
        expect(options.type).toBe('image/png');
        return 'data:image/png;base64,mockPng';
      },
    };
    const res = await generateQrDataUrl('pkx_custom_token', mockEncoder);
    expect(capturedPayload).toBe('https://park-x-flame.vercel.app/v/pkx_custom_token');
    expect(res).toBe('data:image/png;base64,mockPng');

    await generateQrDataUrl('pkx_custom_token', mockEncoder, 'http://localhost:5173');
    expect(capturedPayload).toBe('http://localhost:5173/v/pkx_custom_token');
  });

  it('supports passing baseUrl directly as second argument to generateQrDataUrl', async () => {
    const png = await generateQrDataUrl('pkx_dev_token', 'http://localhost:5173');
    expect(png).toMatch(/^data:image\/png;base64,/);
  });
});
