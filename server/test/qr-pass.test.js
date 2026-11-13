import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQrPayload,
  generateQrDataUrl,
  QR_TOKEN_UNAVAILABLE_MESSAGE,
  DEFAULT_PUBLIC_FRONTEND_URL,
  getPublicFrontendUrl,
  normalizeBaseUrl,
} from '../../src/services/qrPass.js';

test('QR PNG payload contains the issued token exactly once with URL encoding', async () => {
  let payload;
  const png = await generateQrDataUrl('pkx_actual/token', {
    toDataURL: async (value, options) => {
      payload = value;
      assert.equal(options.type, 'image/png');
      return 'data:image/png;base64,iVBORw0KGgo=';
    },
  });
  assert.equal(payload, 'https://park-x-flame.vercel.app/v/pkx_actual%2Ftoken');
  assert.match(png, /^data:image\/png;base64,/);
});

test('missing one-time token cannot produce a fabricated QR payload', () => {
  assert.throws(() => buildQrPayload(''), /newly issued QR token/);
  assert.match(QR_TOKEN_UNAVAILABLE_MESSAGE, /Rotate the token/);
});

test('real QR encoder exports an actual PNG data URL from the bearer URL', async () => {
  const png = await generateQrDataUrl('pkx_real_issuance_token');
  assert.match(png, /^data:image\/png;base64,/);
  const bytes = Buffer.from(png.slice('data:image/png;base64,'.length), 'base64');
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});

test('buildQrPayload uses centralized default public frontend domain', () => {
  assert.equal(DEFAULT_PUBLIC_FRONTEND_URL, 'https://park-x-flame.vercel.app');
  assert.equal(buildQrPayload('token123'), 'https://park-x-flame.vercel.app/v/token123');
});

test('buildQrPayload supports custom base URL overrides and normalizes slashes', () => {
  assert.equal(
    buildQrPayload('token123', 'https://custom-preview.vercel.app/'),
    'https://custom-preview.vercel.app/v/token123'
  );
  assert.equal(
    buildQrPayload('token123', 'http://localhost:5173'),
    'http://localhost:5173/v/token123'
  );
});

test('getPublicFrontendUrl respects environment variable override when present', () => {
  const original = process.env.VITE_PUBLIC_FRONTEND_URL;
  try {
    process.env.VITE_PUBLIC_FRONTEND_URL = 'https://preview.domain.com/';
    assert.equal(getPublicFrontendUrl(), 'https://preview.domain.com');
  } finally {
    if (original === undefined) delete process.env.VITE_PUBLIC_FRONTEND_URL;
    else process.env.VITE_PUBLIC_FRONTEND_URL = original;
  }
});
