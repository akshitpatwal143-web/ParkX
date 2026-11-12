import QRCode from 'qrcode';

export const QR_TOKEN_UNAVAILABLE_MESSAGE = 'This pass cannot be reconstructed because the raw token is only available when issued. Rotate the token to generate a new pass.';

export function buildQrPayload(token) {
  if (typeof token !== 'string' || !token) throw new TypeError('A newly issued QR token is required');
  return `https://parkx.ai/v/${encodeURIComponent(token)}`;
}

export async function generateQrDataUrl(token, encoder = QRCode) {
  return encoder.toDataURL(buildQrPayload(token), {
    width: 320,
    margin: 2,
    type: 'image/png',
    color: { dark: '#080808', light: '#2ee6ca' },
  });
}
