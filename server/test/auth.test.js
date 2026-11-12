import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import { createApp, validateRuntimeConfig } from '../src/index.js';

const origin = 'http://localhost:5173';
const env = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-secret-that-is-at-least-32-bytes-long',
  ALLOWED_ORIGINS: origin,
};

function fakePool() {
  const users = [];
  let id = 1;
  return {
    users,
    async query(sql, params = []) {
      if (sql.startsWith('SELECT 1')) return [[{ 1: 1 }]];
      if (sql.includes('FROM users WHERE email')) {
        const user = users.find((row) => row.email === params[0]);
        if (!user) return [[], []];
        return [[sql.includes('password_hash') ? user : { id: user.id }], []];
      }
      if (sql.includes('INSERT INTO users')) {
        const [, email] = params;
        if (users.some((row) => row.email === email)) {
          const error = new Error('Duplicate email');
          error.code = 'ER_DUP_ENTRY';
          throw error;
        }
        const [full_name, insertedEmail, password_hash] = params;
        const row = { id: id++, full_name, email: insertedEmail, password_hash, created_at: new Date().toISOString() };
        users.push(row);
        return [{ insertId: row.id }, []];
      }
      if (sql.includes('FROM users WHERE id')) {
        const row = users.find((user) => user.id === Number(params[0]));
        return [row ? [{ id: row.id, full_name: row.full_name, email: row.email, created_at: row.created_at }] : [], []];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

const servers = [];
async function harness(options = {}) {
  const pool = options.pool || fakePool();
  const app = createApp({
    env: options.env || env,
    pool,
    store: new session.MemoryStore(),
    loginLimiter: options.loginLimiter,
    signupLimiter: options.signupLimiter,
  });
  const server = await new Promise((resolve) => {
    const current = app.listen(0, '127.0.0.1', () => resolve(current));
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.address().port}`, pool };
}

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

async function csrf(base, cookie) {
  const res = await fetch(`${base}/api/auth/csrf`, { headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) } });
  const setCookie = res.headers.get('set-cookie');
  const token = (await res.json()).csrfToken;
  return { token, cookie: setCookie?.split(';')[0] || cookie };
}

async function post(base, path, body, token, cookie) {
  return fetch(`${base}/api/auth/${path}`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('production config rejects missing or weak session secret', () => {
  assert.throws(() => validateRuntimeConfig({ NODE_ENV: 'production', ALLOWED_ORIGINS: origin, DB_USER: 'parkx_app', DB_PASSWORD: 'dbpass' }), /SESSION_SECRET/);
  assert.throws(() => validateRuntimeConfig({ ...env, NODE_ENV: 'production', SESSION_SECRET: 'short', DB_USER: 'parkx_app', DB_PASSWORD: 'dbpass' }), /SESSION_SECRET/);
});

test('CORS rejects an unapproved browser origin', async () => {
  const { base } = await harness();
  const res = await fetch(`${base}/api/auth/csrf`, { headers: { Origin: 'https://attacker.example' } });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await res.json(), { message: 'Origin is not allowed' });
});

test('approved browser origins receive credentialed CORS headers', async () => {
  const { base } = await harness();
  const res = await fetch(`${base}/api/auth/csrf`, { headers: { Origin: origin } });
  assert.equal(res.headers.get('access-control-allow-origin'), origin);
  assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
});

test('requests without Origin receive no CORS grant but may use safe endpoints', async () => {
  const { base } = await harness();
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('production session cookie has explicit secure attributes', async () => {
  const productionEnv = {
    ...env,
    NODE_ENV: 'production',
    ALLOWED_ORIGINS: 'https://parkx.example',
    DB_USER: 'parkx_runtime',
    DB_PASSWORD: 'test-db-password',
    TRUST_PROXY_HOPS: '1',
  };
  const { base } = await harness({ env: productionEnv });
  const res = await fetch(`${base}/api/auth/csrf`, {
    headers: { Origin: 'https://parkx.example', 'X-Forwarded-Proto': 'https' },
  });
  const cookie = res.headers.get('set-cookie') || '';
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Path=\//i);
  assert.match(cookie, /Expires=/i);
});

test('signup creates an account, rotates the session, and persists authentication', async () => {
  const { base, pool } = await harness();
  const initial = await csrf(base);
  const signup = await post(base, 'signup', { name: 'Sam Park', email: 'SAM@example.com', password: 'password123' }, initial.token, initial.cookie);
  assert.equal(signup.status, 201);
  const rotatedCookie = signup.headers.get('set-cookie')?.split(';')[0];
  assert.ok(rotatedCookie);
  assert.notEqual(rotatedCookie, initial.cookie);
  assert.equal(pool.users.length, 1);
  const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: rotatedCookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, 'sam@example.com');
});

test('login rotates the session identifier', async () => {
  const { base } = await harness();
  const initial = await csrf(base);
  await post(base, 'signup', { name: 'Sam Park', email: 'sam@example.com', password: 'password123' }, initial.token, initial.cookie);
  const loginStart = await csrf(base);
  const res = await post(base, 'login', { email: 'sam@example.com', password: 'password123' }, loginStart.token, loginStart.cookie);
  assert.equal(res.status, 200);
  const nextCookie = res.headers.get('set-cookie')?.split(';')[0];
  assert.ok(nextCookie);
  assert.notEqual(nextCookie, loginStart.cookie);
});

test('state-changing auth requests reject missing and invalid CSRF tokens', async () => {
  const { base } = await harness();
  const missing = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Origin: origin } });
  assert.equal(missing.status, 403);
  const started = await csrf(base);
  const invalid = await post(base, 'logout', undefined, 'invalid-token', started.cookie);
  assert.equal(invalid.status, 403);
});

test('duplicate registration returns the existing 409 contract', async () => {
  const { base } = await harness();
  const first = await csrf(base);
  await post(base, 'signup', { name: 'A Person', email: 'a@example.com', password: 'password123' }, first.token, first.cookie);
  const second = await csrf(base);
  const duplicate = await post(base, 'signup', { name: 'A Person', email: 'A@example.com', password: 'password123' }, second.token, second.cookie);
  assert.equal(duplicate.status, 409);
});

test('concurrent duplicate registrations are serialized by the unique constraint path', async () => {
  const { base, pool } = await harness();
  const first = await csrf(base);
  const second = await csrf(base);
  const requests = await Promise.all([
    post(base, 'signup', { name: 'A Person', email: 'a@example.com', password: 'password123' }, first.token, first.cookie),
    post(base, 'signup', { name: 'Another Person', email: 'A@example.com', password: 'password123' }, second.token, second.cookie),
  ]);
  assert.deepEqual(requests.map((res) => res.status).sort(), [201, 409]);
  assert.equal(pool.users.length, 1);
});

test('invalid payloads and passwords beyond bcrypt byte limit are rejected', async () => {
  const { base } = await harness();
  let started = await csrf(base);
  let res = await post(base, 'signup', { name: {}, email: 'bad', password: 'short' }, started.token, started.cookie);
  assert.equal(res.status, 400);
  assert.ok((await res.json()).errors);
  started = await csrf(base);
  res = await post(base, 'signup', { name: 'A', email: 'a@example.com', password: 'a'.repeat(73) }, started.token, started.cookie);
  assert.equal(res.status, 400);
  assert.match((await res.json()).errors.password, /72 UTF-8 bytes/);
});

test('signup and login rate limits return JSON 429 responses', async () => {
  const { base } = await harness({
    signupLimiter: rateLimit({ windowMs: 60_000, max: 1, standardHeaders: true, legacyHeaders: false, handler: (_req, res) => res.status(429).json({ message: 'Too many signup attempts. Please try again later.' }) }),
    loginLimiter: rateLimit({ windowMs: 60_000, max: 1, standardHeaders: true, legacyHeaders: false, handler: (_req, res) => res.status(429).json({ message: 'Too many login attempts. Please try again later.' }) }),
  });
  let started = await csrf(base);
  await post(base, 'signup', { name: 'A', email: 'a@example.com', password: 'password123' }, started.token, started.cookie);
  started = await csrf(base);
  const signupLimited = await post(base, 'signup', { name: 'B', email: 'b@example.com', password: 'password123' }, started.token, started.cookie);
  assert.equal(signupLimited.status, 429);
  const loginStart = await csrf(base);
  await post(base, 'login', { email: 'a@example.com', password: 'wrong-password' }, loginStart.token, loginStart.cookie);
  const loginLimited = await post(base, 'login', { email: 'a@example.com', password: 'wrong-password' }, loginStart.token, loginStart.cookie);
  assert.equal(loginLimited.status, 429);
  assert.match((await loginLimited.json()).message, /Too many login attempts/);
});

test('logout invalidates the stored session', async () => {
  const { base } = await harness();
  const initial = await csrf(base);
  const signup = await post(base, 'signup', { name: 'A Person', email: 'a@example.com', password: 'password123' }, initial.token, initial.cookie);
  const cookie = signup.headers.get('set-cookie')?.split(';')[0];
  const logoutStart = await csrf(base, cookie);
  const logout = await post(base, 'logout', undefined, logoutStart.token, cookie);
  assert.equal(logout.status, 200);
  const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 401);
});

test('authentication database errors log only safe metadata and return a generic response', async () => {
  const secretValues = 'SELECT password_hash WHERE email=sensitive.person@example.test password=not-a-real-password cookie=parkx.sid=secret-cookie';
  const pool = {
    async query() {
      const error = new Error(secretValues);
      error.code = 'ER_BAD_DB_ERROR';
      throw error;
    },
  };
  const { base } = await harness({ pool });
  const { cookie, token } = await csrf(base);
  const messages = [];
  const originalError = console.error;
  console.error = (...args) => messages.push(args);
  let response;
  try {
    response = await fetch(`${base}/api/auth/signup`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
        'X-Request-ID': 'auth-log-test-22',
        Cookie: cookie,
      },
      body: JSON.stringify({ name: 'Test Owner', email: 'sensitive.person@example.test', password: 'not-a-real-password' }),
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { message: 'Internal server error' });
  assert.equal(response.headers.get('x-request-id'), 'auth-log-test-22');
  const serialized = JSON.stringify(messages);
  for (const sensitive of ['sensitive.person@example.test', 'not-a-real-password', 'password_hash', 'secret-cookie', 'SELECT']) {
    assert.equal(serialized.includes(sensitive), false, `log included ${sensitive}`);
  }
  assert.match(serialized, /ER_BAD_DB_ERROR/);
  assert.match(serialized, /signup/);
  assert.match(serialized, /auth-log-test-22/);
});
