import test from 'node:test';
import assert from 'node:assert/strict';
import { getMe } from '../../src/services/authService.js';
import { getAuthStatus } from '../../src/context/authStatus.js';

const realFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test('frontend distinguishes unauthenticated sessions from an unavailable backend', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Not authenticated' }), { status: 401 });
  assert.deepEqual(await getMe(), { user: null });

  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(getMe(), (error) => {
    assert.match(error.message, /Failed to fetch/);
    assert.equal(getAuthStatus(false, error.message), 'unavailable');
    return true;
  });

  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Service unavailable' }), { status: 503 });
  await assert.rejects(getMe(), (error) => {
    assert.match(error.message, /Service unavailable/);
    assert.equal(getAuthStatus(false, error.message), 'unavailable');
    return true;
  });
  assert.equal(getAuthStatus(true, ''), 'loading');
  assert.equal(getAuthStatus(false, ''), 'ready');
});
