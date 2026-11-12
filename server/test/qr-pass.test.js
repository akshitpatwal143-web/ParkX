import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQrPayload, generateQrDataUrl, QR_TOKEN_UNAVAILABLE_MESSAGE } from '../../src/services/qrPass.js';

test('QR PNG payload contains the issued token exactly once with URL encoding', async () => {
  let payload;
  const png = await generateQrDataUrl('pkx_actual/token', {
    toDataURL: async (value, options) => {
      payload = value;
      assert.equal(options.type, 'image/png');
      return 'data:image/png;base64,iVBORw0KGgo=';
    },
  });
  assert.equal(payload, 'https://parkx.ai/v/pkx_actual%2Ftoken');
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
