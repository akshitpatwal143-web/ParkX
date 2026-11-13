import QRCode from 'qrcode';

export const DEFAULT_PUBLIC_FRONTEND_URL = 'https://park-x-flame.vercel.app';
export const QR_TOKEN_UNAVAILABLE_MESSAGE =
  'This pass cannot be reconstructed because the raw token is only available when issued. Rotate the token to generate a new pass.';

/**
 * Normalizes a base URL by trimming whitespace and removing trailing slashes.
 * @param {string} url
 * @returns {string}
 */
export function normalizeBaseUrl(url) {
  if (typeof url !== 'string') return '';
  return url.trim().replace(/\/+$/, '');
}

/**
 * Resolves the centralized public frontend base URL used for QR pass generation.
 *
 * Resolution order:
 * 1. Explicit override passed as parameter.
 * 2. Vite environment variable: `import.meta.env.VITE_PUBLIC_FRONTEND_URL` (browser / Vite dev / build).
 * 3. Node environment variable: `process.env.VITE_PUBLIC_FRONTEND_URL` or `process.env.PUBLIC_FRONTEND_URL` (tests / tooling).
 * 4. Default production Vercel frontend domain: `https://park-x-flame.vercel.app`.
 *
 * Local development note:
 * QR codes default to the production Vercel domain so that passes scanned by physical mobile
 * devices are immediately routeable over the public internet. If local end-to-end device testing
 * is needed, configure `VITE_PUBLIC_FRONTEND_URL` (e.g. `http://192.168.1.100:5173` or tunnel).
 *
 * @param {string} [overrideUrl]
 * @returns {string}
 */
export function getPublicFrontendUrl(overrideUrl) {
  if (overrideUrl) {
    const normalized = normalizeBaseUrl(overrideUrl);
    if (normalized) return normalized;
  }

  try {
    if (typeof import.meta !== 'undefined' && import.meta?.env?.VITE_PUBLIC_FRONTEND_URL) {
      const normalized = normalizeBaseUrl(import.meta.env.VITE_PUBLIC_FRONTEND_URL);
      if (normalized) return normalized;
    }
  } catch {
    // import.meta may be undefined or unsupported in certain runtimes
  }

  try {
    if (typeof process !== 'undefined' && process?.env) {
      const envUrl = process.env.VITE_PUBLIC_FRONTEND_URL || process.env.PUBLIC_FRONTEND_URL;
      const normalized = normalizeBaseUrl(envUrl);
      if (normalized) return normalized;
    }
  } catch {
    // process may be undefined in certain browser bundles
  }

  return DEFAULT_PUBLIC_FRONTEND_URL;
}

/**
 * Constructs the public vehicle visitor URL for a given issued token.
 * Output format: `${baseUrl}/v/${encodeURIComponent(token)}`
 *
 * @param {string} token
 * @param {string} [baseUrl]
 * @returns {string}
 */
export function buildQrPayload(token, baseUrl) {
  if (typeof token !== 'string' || !token) {
    throw new TypeError('A newly issued QR token is required');
  }
  const resolvedBaseUrl = getPublicFrontendUrl(baseUrl);
  return `${resolvedBaseUrl}/v/${encodeURIComponent(token)}`;
}

/**
 * Generates a PNG data URL for the public vehicle pass QR code.
 *
 * @param {string} token
 * @param {object|string} [encoder=QRCode] QRCode instance/mock or custom baseUrl string
 * @param {string} [baseUrl]
 * @returns {Promise<string>}
 */
export async function generateQrDataUrl(token, encoder = QRCode, baseUrl) {
  let resolvedEncoder = QRCode;
  let resolvedBaseUrl = baseUrl;

  if (typeof encoder === 'string') {
    resolvedBaseUrl = encoder;
  } else if (encoder && typeof encoder.toDataURL === 'function') {
    resolvedEncoder = encoder;
  }

  return resolvedEncoder.toDataURL(buildQrPayload(token, resolvedBaseUrl), {
    width: 320,
    margin: 2,
    type: 'image/png',
    color: { dark: '#080808', light: '#2ee6ca' },
  });
}
