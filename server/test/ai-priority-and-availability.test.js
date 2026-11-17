import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMessagePriority,
  classifyAndStoreMessagePriority,
  setAiClassifierForTesting,
  resetAiClassifierForTesting,
  redactPiiForAi,
  isRedactionSafe,
  DEFAULT_AI_MODEL,
  PRIORITY_LEVELS,
  PRIORITY_RANKS,
} from '../src/services/aiPriority.js';
import {
  handleAutoReplyForSession,
  DEFAULT_BUSY_MESSAGE,
  DEFAULT_AWAY_MESSAGE,
} from '../src/services/autoReply.js';
import { createVehiclesRouter } from '../src/routes/vehicles.js';
import {
  sendPushNotificationForSession,
  setPushProviderForTesting,
  resetPushProviderForTesting,
} from '../src/services/pushNotification.js';
import {
  verifyAiPriorityAndAvailabilitySchema,
} from '../src/migrate.js';

test.afterEach(() => {
  resetAiClassifierForTesting();
  resetPushProviderForTesting();
});

test('Phase 3.5 — AI Priority Classification Suite', async (t) => {
  await t.test('1. Classifies all 4 priorities accurately via AI provider', async () => {
    const testCases = [
      { text: 'An ambulance is blocked by your car! Please move immediately!', priority: 'urgent', reason: 'Emergency vehicle blocked' },
      { text: 'You are blocking my driveway and I cannot get to work.', priority: 'high', reason: 'Blocked private driveway' },
      { text: 'Hi, what time do you think you will be back?', priority: 'normal', reason: 'General return time inquiry' },
      { text: 'Nice car! Love the color!', priority: 'low', reason: 'Compliment / non-actionable note' },
    ];

    for (const tc of testCases) {
      setAiClassifierForTesting(async (text) => {
        assert.equal(text, tc.text);
        return { priority: tc.priority, reason: tc.reason };
      });

      const res = await classifyMessagePriority(tc.text);
      assert.equal(res.priority, tc.priority);
      assert.equal(res.reason, tc.reason);
    }
  });

  await t.test('2. Defaults safely to NORMAL if AI is unconfigured or unavailable without claiming AI ran', async () => {
    const oldKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      const res = await classifyMessagePriority('Urgent please move!');
      assert.equal(res.priority, 'normal');
      assert.equal(res.reason, 'Default priority');
    } finally {
      if (oldKey) process.env.GEMINI_API_KEY = oldKey;
    }
  });

  await t.test('3. Constrains invalid AI output and defaults to NORMAL', async () => {
    setAiClassifierForTesting(async () => ({
      priority: 'CRITICAL_INVALID_LEVEL',
      reason: 'Unknown level',
    }));

    const res = await classifyMessagePriority('Test message');
    assert.equal(res.priority, 'normal');
    assert.equal(res.reason, 'Unknown level');
  });

  await t.test('4. Handles AI provider error gracefully with NORMAL fallback', async () => {
    setAiClassifierForTesting(async () => {
      throw new Error('AI API rate limit exceeded or network down');
    });

    const res = await classifyMessagePriority('Emergency!');
    assert.equal(res.priority, 'normal');
    assert.equal(res.reason, 'Default priority');
  });

  await t.test('5. PII redaction strips registrations, addresses, names, phone, email, URL, and identifiers before AI processing', () => {
    const sample = 'My name is John Doe. Vehicle DL01AB1234 and MH-12-AB-1234 (also 22 BH 1234 AA) are blocking 123 MG Road, Sector 14. Call +1 (555) 123-4567 or 9876543210. Email user@example.com or visit https://park.example.com. ID: 1234-5678-9012. Regards, Jane Smith.';
    const redacted = redactPiiForAi(sample);

    // Vehicle registrations must be redacted
    assert.ok(!redacted.includes('DL01AB1234'));
    assert.ok(!redacted.includes('MH-12-AB-1234'));
    assert.ok(!redacted.includes('22 BH 1234 AA'));
    assert.ok(redacted.includes('[VEHICLE_REGISTRATION]'));

    // Addresses must be redacted
    assert.ok(!redacted.includes('123 MG Road'));
    assert.ok(!redacted.includes('Sector 14'));
    assert.ok(redacted.includes('[ADDRESS]'));

    // Names must be redacted
    assert.ok(!redacted.includes('John Doe'));
    assert.ok(!redacted.includes('Jane Smith'));
    assert.ok(redacted.includes('[NAME]'));

    // Phones, emails, links, and identifiers must be redacted
    assert.ok(!redacted.includes('555'));
    assert.ok(!redacted.includes('9876543210'));
    assert.ok(!redacted.includes('user@example.com'));
    assert.ok(!redacted.includes('https://park.example.com'));
    assert.ok(!redacted.includes('1234-5678-9012'));
    assert.ok(redacted.includes('[PHONE]'));
    assert.ok(redacted.includes('[EMAIL]'));
    assert.ok(redacted.includes('[LINK]'));
    assert.ok(redacted.includes('[IDENTIFIER]'));

    // Conservative fail-closed checks
    assert.equal(isRedactionSafe(redacted), true);
    assert.equal(isRedactionSafe('Still has email: test@domain.com'), false);
    assert.equal(isRedactionSafe('Still has link: https://example.com'), false);
    assert.equal(isRedactionSafe('Still has 10 digits 9876543210'), false);
    assert.equal(isRedactionSafe(''), false);

    // Regression test for reported bypass: "My friend Ravi is outside with plate ABC123 at 12B Oak St."
    const reportedBypass = 'My friend Ravi is outside with plate ABC123 at 12B Oak St.';
    const redactedBypass = redactPiiForAi(reportedBypass);
    assert.ok(!redactedBypass.includes('Ravi'), 'Name Ravi must not appear');
    assert.ok(!redactedBypass.includes('ABC123'), 'Plate ABC123 must not appear');
    assert.ok(!redactedBypass.includes('12B'), 'Alphanumeric building number 12B must not appear');
    assert.ok(!redactedBypass.includes('Oak St'), 'Street name Oak St must not appear');
    assert.ok(redactedBypass.includes('[NAME]'));
    assert.ok(redactedBypass.includes('[VEHICLE_REGISTRATION]'));
    assert.ok(redactedBypass.includes('[ADDRESS]'));
    assert.equal(isRedactionSafe(redactedBypass), true);

    // Variations of bypass
    const var1 = 'Please hurry, my colleague Priya has plate 7XYZ89 parked near 45 Elm Rd.';
    const red1 = redactPiiForAi(var1);
    assert.ok(!red1.includes('Priya'));
    assert.ok(!red1.includes('7XYZ89'));
    assert.ok(!red1.includes('Elm Rd'));
    assert.equal(isRedactionSafe(red1), true);

    const var2 = 'Contact driver John at Oak Street regarding vehicle DL-04-A-1234.';
    const red2 = redactPiiForAi(var2);
    assert.ok(!red2.includes('John'));
    assert.ok(!red2.includes('Oak Street'));
    assert.ok(!red2.includes('DL-04-A-1234'));
    assert.equal(isRedactionSafe(red2), true);

    const var3 = 'Car tag ABC 123 blocking garage at 12B Oak St.';
    const red3 = redactPiiForAi(var3);
    assert.ok(!red3.includes('ABC 123'));
    assert.ok(!red3.includes('12B Oak St'));
    assert.equal(isRedactionSafe(red3), true);
  });

  await t.test('6. Mocked Gemini HTTP request construction, model selection (gemini-3.8-flash), prompt sanitization, and response parsing', async () => {
    assert.equal(DEFAULT_AI_MODEL, 'gemini-3.8-flash');
    const originalFetch = globalThis.fetch;
    let interceptedUrl = null;
    let interceptedBody = null;

    globalThis.fetch = async (url, options) => {
      interceptedUrl = url;
      interceptedBody = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: '{"priority":"urgent","reason":"Blocking ambulance access"}',
                    },
                  ],
                },
              },
            ],
          };
        },
      };
    };

    try {
      // 1. Default model (gemini-3.8-flash) and verify all PII categories are stripped from prompt
      const res = await classifyMessagePriority(
        'Ambulance blocked! Car DL01AB1234 at 123 MG Road, Sector 14. My name is John Doe. Call me at +91 99999 88888 or email alert@example.com or visit https://parkx.io/alert',
        { apiKey: 'test-gemini-key' }
      );

      assert.equal(res.priority, 'urgent');
      assert.equal(res.reason, 'Blocking ambulance access');
      assert.ok(interceptedUrl.includes('models/gemini-3.8-flash:generateContent?key=test-gemini-key'));

      // Verify PII was redacted in prompt text: registrations, addresses, names, phones, emails, and links
      const promptText = interceptedBody.contents[0].parts[0].text;
      assert.ok(!promptText.includes('DL01AB1234'), 'Registration must not be sent to Gemini');
      assert.ok(!promptText.includes('123 MG Road'), 'Address must not be sent to Gemini');
      assert.ok(!promptText.includes('John Doe'), 'Name must not be sent to Gemini');
      assert.ok(!promptText.includes('99999'), 'Phone must not be sent to Gemini');
      assert.ok(!promptText.includes('alert@example.com'), 'Email must not be sent to Gemini');
      assert.ok(!promptText.includes('https://parkx.io'), 'URL must not be sent to Gemini');
      assert.ok(promptText.includes('[VEHICLE_REGISTRATION]'));
      assert.ok(promptText.includes('[ADDRESS]'));
      assert.ok(promptText.includes('[NAME]'));
      assert.ok(promptText.includes('[PHONE]'));
      assert.ok(promptText.includes('[EMAIL]'));
      assert.ok(promptText.includes('[LINK]'));

      // 2. Preserves configurable AI_MODEL
      const resCustom = await classifyMessagePriority('Ambulance blocked!', {
        apiKey: 'test-gemini-key',
        model: 'gemini-custom-test-model',
      });
      assert.equal(resCustom.priority, 'urgent');
      assert.ok(interceptedUrl.includes('models/gemini-custom-test-model:generateContent?key=test-gemini-key'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test('6b. Stubs fetch to assert unsafe text and reported bypass NEVER reach Gemini', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls = [];

    globalThis.fetch = async (url, options) => {
      fetchCalls.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        async json() {
          return {
            candidates: [
              { content: { parts: [{ text: '{"priority":"high","reason":"Blocked car"}' }] } },
            ],
          };
        },
      };
    };

    try {
      // 1. Exact reported bypass: "My friend Ravi is outside with plate ABC123 at 12B Oak St."
      fetchCalls.length = 0;
      const resBypass = await classifyMessagePriority(
        'My friend Ravi is outside with plate ABC123 at 12B Oak St. You are blocking him in.',
        { apiKey: 'test-gemini-key' }
      );

      assert.equal(resBypass.priority, 'high');
      assert.equal(fetchCalls.length, 1);
      const promptBypass = fetchCalls[0].body.contents[0].parts[0].text;
      assert.ok(!promptBypass.includes('Ravi'), 'Name Ravi must NEVER reach Gemini');
      assert.ok(!promptBypass.includes('ABC123'), 'Plate ABC123 must NEVER reach Gemini');
      assert.ok(!promptBypass.includes('12B'), '12B must NEVER reach Gemini');
      assert.ok(!promptBypass.includes('Oak St'), 'Oak St must NEVER reach Gemini');

      // 2. Variations
      fetchCalls.length = 0;
      await classifyMessagePriority(
        'Please hurry, my colleague Priya has plate 7XYZ89 parked near 45 Elm Rd.',
        { apiKey: 'test-gemini-key' }
      );
      assert.equal(fetchCalls.length, 1);
      const promptVar1 = fetchCalls[0].body.contents[0].parts[0].text;
      assert.ok(!promptVar1.includes('Priya'));
      assert.ok(!promptVar1.includes('7XYZ89'));
      assert.ok(!promptVar1.includes('Elm Rd'));

      // 3. Fail-closed: text with unsafe / unredactable pattern skips fetch completely
      fetchCalls.length = 0;
      const resUnsafe = await classifyMessagePriority(
        'Please come quickly, Zorblax is waiting outside.',
        { apiKey: 'test-gemini-key' }
      );
      assert.equal(fetchCalls.length, 0, 'Fetch must NEVER be called when safe redaction cannot be established');
      assert.equal(resUnsafe.priority, 'normal', 'Must safely default to normal priority');
      assert.equal(resUnsafe.reason, 'Default priority');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test('7. Mocked Gemini HTTP handles rate limit / quota (429), server errors (500), malformed responses, and timeout safely', async () => {
    const originalFetch = globalThis.fetch;

    // A) HTTP 429 Rate limit / Quota exceeded
    globalThis.fetch = async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      async json() {
        return {
          error: {
            code: 429,
            message: 'Resource has been exhausted (e.g. check quota).',
            status: 'RESOURCE_EXHAUSTED',
          },
        };
      },
    });

    try {
      const res429 = await classifyMessagePriority('Help please!', { apiKey: 'key', model: DEFAULT_AI_MODEL });
      assert.equal(res429.priority, 'normal');
      assert.equal(res429.reason, 'Default priority');

      // B) HTTP 500 internal server error
      globalThis.fetch = async () => ({
        ok: false,
        status: 500,
        async json() { return {}; },
      });

      const res500 = await classifyMessagePriority('Help!', { apiKey: 'key', model: DEFAULT_AI_MODEL });
      assert.equal(res500.priority, 'normal');
      assert.equal(res500.reason, 'Default priority');

      // C) Malformed candidate text (invalid JSON in candidate)
      globalThis.fetch = async () => ({
        ok: true,
        async json() {
          return { candidates: [{ content: { parts: [{ text: 'NOT VALID JSON' }] } }] };
        },
      });

      const resBad = await classifyMessagePriority('Help!', { apiKey: 'key', model: DEFAULT_AI_MODEL });
      assert.equal(resBad.priority, 'normal');
      assert.equal(resBad.reason, 'Default priority');

      // D) Empty candidates array
      globalThis.fetch = async () => ({
        ok: true,
        async json() {
          return { candidates: [] };
        },
      });

      const resEmpty = await classifyMessagePriority('Help!', { apiKey: 'key', model: DEFAULT_AI_MODEL });
      assert.equal(resEmpty.priority, 'normal');
      assert.equal(resEmpty.reason, 'Default priority');

      // E) Timeout / aborted request
      globalThis.fetch = async (url, { signal }) => {
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      };

      const resTimeout = await classifyMessagePriority('Help!', {
        apiKey: 'key',
        model: DEFAULT_AI_MODEL,
        timeoutMs: 20,
      });
      assert.equal(resTimeout.priority, 'normal');
      assert.equal(resTimeout.reason, 'Default priority');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test('8. Priority aggregation: delayed classification never lowers priority while higher-priority message exists', async () => {
    let committedSessionPriority = null;

    const mockConn = {
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      release() {},
      async query(sql, params) {
        if (sql.includes('FROM visitor_sessions') && sql.includes('FOR UPDATE')) {
          // Session exists, not manually overridden
          return [[{ id: 1, priority_overridden: 0, session_priority: 'urgent' }]];
        }
        if (sql.includes('UPDATE visitor_messages')) {
          return [{ affectedRows: 1 }];
        }
        if (sql.includes('UPDATE visitor_sessions')) {
          committedSessionPriority = 'recomputed_via_order_by';
          return [{ affectedRows: 1 }];
        }
        return [[]];
      },
    };

    const mockPool = {
      async getConnection() { return mockConn; },
    };

    setAiClassifierForTesting(async () => ({
      priority: 'low',
      reason: 'Just a casual compliment',
    }));

    await classifyAndStoreMessagePriority({
      pool: mockPool,
      messageId: 10,
      sessionDbId: 1,
      body: 'Nice parking job!',
    });

    assert.equal(committedSessionPriority, 'recomputed_via_order_by');
  });

  await t.test('9. Manual priority overrides survive delayed AI results', async () => {
    let sessionUpdateAttempted = false;

    const mockConn = {
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      release() {},
      async query(sql) {
        if (sql.includes('FROM visitor_sessions') && sql.includes('FOR UPDATE')) {
          // Owner has manually overridden this session's priority
          return [[{ id: 1, priority_overridden: 1, session_priority: 'high' }]];
        }
        if (sql.includes('UPDATE visitor_messages')) {
          return [{ affectedRows: 1 }];
        }
        if (sql.includes('UPDATE visitor_sessions')) {
          sessionUpdateAttempted = true;
          return [{ affectedRows: 0 }];
        }
        return [[]];
      },
    };

    const mockPool = {
      async getConnection() { return mockConn; },
    };

    setAiClassifierForTesting(async () => ({
      priority: 'low',
      reason: 'Casual remark',
    }));

    await classifyAndStoreMessagePriority({
      pool: mockPool,
      messageId: 10,
      sessionDbId: 1,
      body: 'Hello!',
    });

    // Session update was safely skipped because priority_overridden was 1
    assert.equal(sessionUpdateAttempted, false);
  });
});

test('Phase 3.5 — Safe Automatic Replies Suite', async (t) => {
  function makeMockPool({
    status = 'busy',
    version = 1,
    enabled = true,
    busyMsg = DEFAULT_BUSY_MESSAGE,
    awayMsg = DEFAULT_AWAY_MESSAGE,
    sessionStatus = 'pending',
    expiresAt = new Date(Date.now() + 3600000),
    lastAutoReplyVersion = null,
    failInsert = false,
  } = {}) {
    let currentLastVersion = lastAutoReplyVersion;
    const insertedMessages = [];
    let rolledBack = false;
    let committed = false;

    const conn = {
      async beginTransaction() {},
      async commit() { committed = true; },
      async rollback() { rolledBack = true; },
      release() {},
      async query(sql, params) {
        if (sql.includes('FROM visitor_sessions s') && sql.includes('JOIN users u')) {
          return [[{
            user_id: 1,
            availability_status: status,
            availability_version: version,
            auto_reply_enabled: enabled ? 1 : 0,
            auto_reply_busy: busyMsg,
            auto_reply_away: awayMsg,
            session_db_id: 1,
            session_status: sessionStatus,
            expires_at: expiresAt,
            last_auto_reply_version: currentLastVersion,
          }]];
        }

        if (sql.includes('UPDATE visitor_sessions') && sql.includes('SET last_auto_reply_status = ?')) {
          currentLastVersion = params[1];
          return [{ affectedRows: 1 }];
        }

        if (sql.includes('INSERT INTO visitor_messages')) {
          if (failInsert) {
            throw new Error('Simulated DB insert failure');
          }
          const isAutoReply = sql.includes('TRUE');
          const body = params[1];
          insertedMessages.push({ isAutoReply, body });
          return [{ insertId: insertedMessages.length }];
        }

        return [[]];
      },
    };

    return {
      insertedMessages,
      getLastAutoReplyVersion: () => currentLastVersion,
      wasRolledBack: () => rolledBack,
      wasCommitted: () => committed,
      async getConnection() { return conn; },
    };
  }

  await t.test('1. No auto-reply sent when owner is AVAILABLE', async () => {
    const pool = makeMockPool({ status: 'available', enabled: true });
    const res = await handleAutoReplyForSession({ pool, sessionDbId: 1, sessionId: 'vs_1', vehicleId: 10 });
    assert.equal(res.sent, false);
    assert.equal(res.reason, 'owner_available');
    assert.equal(pool.insertedMessages.length, 0);
  });

  await t.test('2. Dispatches busy auto-reply when owner is BUSY and enabled', async () => {
    const pool = makeMockPool({ status: 'busy', version: 1, enabled: true });
    const res = await handleAutoReplyForSession({ pool, sessionDbId: 1, sessionId: 'vs_1', vehicleId: 10 });
    assert.equal(res.sent, true);
    assert.equal(res.body, DEFAULT_BUSY_MESSAGE);
    assert.equal(pool.insertedMessages.length, 1);
    assert.equal(pool.insertedMessages[0].isAutoReply, true);
    assert.equal(pool.getLastAutoReplyVersion(), 1);
    assert.equal(pool.wasCommitted(), true);
  });

  await t.test('3. Dispatches away auto-reply when owner is AWAY and enabled', async () => {
    const pool = makeMockPool({ status: 'away', version: 1, enabled: true });
    const res = await handleAutoReplyForSession({ pool, sessionDbId: 1, sessionId: 'vs_1', vehicleId: 10 });
    assert.equal(res.sent, true);
    assert.equal(res.body, DEFAULT_AWAY_MESSAGE);
    assert.equal(pool.insertedMessages.length, 1);
    assert.equal(pool.insertedMessages[0].isAutoReply, true);
    assert.equal(pool.getLastAutoReplyVersion(), 1);
  });

  await t.test('4. Anti-spam: at most ONE auto-reply per availability version/period', async () => {
    const pool = makeMockPool({ status: 'busy', version: 2, enabled: true, lastAutoReplyVersion: 2 });
    const res = await handleAutoReplyForSession({ pool, sessionDbId: 1, sessionId: 'vs_1', vehicleId: 10 });
    assert.equal(res.sent, false);
    assert.equal(res.reason, 'already_sent_for_period');
    assert.equal(pool.insertedMessages.length, 0);
  });

  await t.test('5. Transition tracking: BUSY (v1) -> AVAILABLE (v2) -> BUSY (v3) allows exactly one new auto-reply', async () => {
    // Owner was busy in v1 and sent auto-reply (lastAutoReplyVersion = 1).
    // Owner is now in a NEW busy period at version 3!
    const pool = makeMockPool({ status: 'busy', version: 3, enabled: true, lastAutoReplyVersion: 1 });
    const res = await handleAutoReplyForSession({ pool, sessionDbId: 1, sessionId: 'vs_1', vehicleId: 10 });
    assert.equal(res.sent, true);
    assert.equal(res.body, DEFAULT_BUSY_MESSAGE);
    assert.equal(pool.insertedMessages.length, 1);
    assert.equal(pool.getLastAutoReplyVersion(), 3);
  });

  await t.test('6. Availability changes while auto-reply is in progress to AVAILABLE prevents dispatch', async () => {
    // Owner toggled to available right when query executed
    const pool = makeMockPool({ status: 'available', version: 4, enabled: true });
    const res = await handleAutoReplyForSession({ pool, sessionDbId: 1, sessionId: 'vs_1', vehicleId: 10 });
    assert.equal(res.sent, false);
    assert.equal(res.reason, 'owner_available');
    assert.equal(pool.insertedMessages.length, 0);
  });

  await t.test('7. Rollback when auto-reply message insertion fails rolls back the claim', async () => {
    const pool = makeMockPool({ status: 'busy', version: 5, enabled: true, failInsert: true });
    await assert.rejects(
      async () => {
        await handleAutoReplyForSession({ pool, sessionDbId: 1, sessionId: 'vs_1', vehicleId: 10 });
      },
      /Simulated DB insert failure/
    );
    assert.equal(pool.wasRolledBack(), true);
    assert.equal(pool.wasCommitted(), false);
  });

  await t.test('8. Disabled auto-replies prevent dispatch even when BUSY or AWAY', async () => {
    const pool = makeMockPool({ status: 'busy', enabled: false });
    const res = await handleAutoReplyForSession({ pool, sessionDbId: 1, sessionId: 'vs_1', vehicleId: 10 });
    assert.equal(res.sent, false);
    assert.equal(res.reason, 'auto_reply_disabled');
    assert.equal(pool.insertedMessages.length, 0);
  });

  await t.test('9. Rejects auto-reply if session has expired even when status is pending or accepted', async () => {
    const pool = makeMockPool({
      status: 'busy',
      sessionStatus: 'accepted',
      expiresAt: new Date(Date.now() - 5000), // Expired 5 seconds ago
    });
    const res = await handleAutoReplyForSession({ pool, sessionDbId: 1, sessionId: 'vs_1', vehicleId: 10 });
    assert.equal(res.sent, false);
    assert.equal(res.reason, 'session_expired');
    assert.equal(pool.insertedMessages.length, 0);
  });
});

test('Phase 3.5 — Owner Availability & Priority Override Routes', async (t) => {
  function makeFakeReq(options = {}) {
    return {
      method: options.method || 'GET',
      url: options.url || '/',
      params: options.params || {},
      query: options.query || {},
      body: options.body || {},
      headers: options.headers || {},
      get(name) {
        return this.headers[name] || this.headers[name.toLowerCase()] || undefined;
      },
      session: options.session || { userId: 1, csrfToken: 'test_token' },
    };
  }

  function invokeRouter(router, req) {
    return new Promise((resolve) => {
      const res = {
        _status: 200,
        _headers: {},
        _body: null,
        status(s) { this._status = s; return this; },
        setHeader(k, v) { this._headers[k] = v; return this; },
        json(b) { this._body = b; resolve({ status: this._status, body: b, headers: this._headers }); },
        end() { resolve({ status: this._status, body: this._body, headers: this._headers }); },
      };
      router(req, res, () => {
        resolve({ status: 404, body: { message: 'Not found' } });
      });
    });
  }

  await t.test('1. Strict JSON boolean validation: rejects "false", "true", or numbers for autoReplyEnabled', async () => {
    const mockPool = {
      async query() { return [[]]; },
    };
    const router = createVehiclesRouter({ pool: mockPool });

    // String "false"
    const resStringFalse = await invokeRouter(router, makeFakeReq({
      method: 'PATCH',
      url: '/availability',
      headers: { 'X-CSRF-Token': 'test_token' },
      body: { autoReplyEnabled: 'false' },
    }));
    assert.equal(resStringFalse.status, 400);
    assert.ok(resStringFalse.body.message.includes('must be a boolean'));

    // Number 0
    const resNum = await invokeRouter(router, makeFakeReq({
      method: 'PATCH',
      url: '/availability',
      headers: { 'X-CSRF-Token': 'test_token' },
      body: { autoReplyEnabled: 0 },
    }));
    assert.equal(resNum.status, 400);

    // Number 1
    const resNum1 = await invokeRouter(router, makeFakeReq({
      method: 'PATCH',
      url: '/availability',
      headers: { 'X-CSRF-Token': 'test_token' },
      body: { autoReplyEnabled: 1 },
    }));
    assert.equal(resNum1.status, 400);
  });

  await t.test('2. PATCH /api/vehicles/availability updates status and increments version only on actual status change', async () => {
    let updateSql = '';

    const userInDb = {
      id: 1,
      availability_status: 'available',
      availability_version: 1,
      auto_reply_enabled: 0,
      auto_reply_busy: DEFAULT_BUSY_MESSAGE,
      auto_reply_away: DEFAULT_AWAY_MESSAGE,
      availability_updated_at: new Date(),
    };

    const mockPool = {
      async query(sql, params) {
        if (sql.includes('UPDATE users')) {
          updateSql = sql;
          return [{ affectedRows: 1 }];
        }
        if (sql.includes('FROM users')) {
          return [[userInDb]];
        }
        return [[]];
      },
    };

    const router = createVehiclesRouter({ pool: mockPool });

    // 1. Status changes: available -> away (increments version)
    const okRes = await invokeRouter(router, makeFakeReq({
      method: 'PATCH',
      url: '/availability',
      headers: { 'X-CSRF-Token': 'test_token' },
      body: {
        status: 'away',
        autoReplyEnabled: true,
        autoReplyAway: 'Stepped away for 10 minutes.',
      },
    }));
    assert.equal(okRes.status, 200);
    assert.ok(updateSql.includes('availability_version = availability_version + 1'));

    // 2. Status repeated: away -> away (does NOT increment version)
    userInDb.availability_status = 'away';
    userInDb.availability_version = 2;
    updateSql = '';

    const repeatedRes = await invokeRouter(router, makeFakeReq({
      method: 'PATCH',
      url: '/availability',
      headers: { 'X-CSRF-Token': 'test_token' },
      body: {
        status: 'away',
        autoReplyAway: 'Still away.',
      },
    }));
    assert.equal(repeatedRes.status, 200);
    assert.ok(!updateSql.includes('availability_version = availability_version + 1'));
    assert.ok(updateSql.includes('auto_reply_away = ?'));
  });

  await t.test('3. Manual priority override: transactional update rolls back if message is not found', async () => {
    let rolledBack = false;

    const mockConn = {
      async beginTransaction() {},
      async commit() {},
      async rollback() { rolledBack = true; },
      release() {},
      async query(sql) {
        if (sql.includes('FROM visitor_sessions s') && sql.includes('FOR UPDATE')) {
          return [[{ id: 9, public_id: 'vs_' + 'c'.repeat(48) }]];
        }
        if (sql.includes('UPDATE visitor_messages')) {
          // Message not in session
          return [{ affectedRows: 0 }];
        }
        return [[]];
      },
    };

    const mockPool = {
      async getConnection() { return mockConn; },
    };

    const router = createVehiclesRouter({ pool: mockPool });
    const validSessionId = 'vs_' + 'c'.repeat(48);

    const res = await invokeRouter(router, makeFakeReq({
      method: 'PATCH',
      url: `/sessions/${validSessionId}/priority`,
      params: { sessionId: validSessionId },
      headers: { 'X-CSRF-Token': 'test_token' },
      body: { priority: 'urgent', messageId: 999 },
    }));

    assert.equal(res.status, 404);
    assert.equal(rolledBack, true);
  });
});

test('Phase 3.5 — Migration 010 Schema Verification Suite', async (t) => {
  function makeMockSchemaConnection(overrides = {}) {
    return {
      async query(sql, params) {
        if (sql.includes("TABLE_NAME = 'users'")) {
          const defaultCols = [
            { COLUMN_NAME: 'availability_status', COLUMN_TYPE: "enum('available','busy','away')", IS_NULLABLE: 'NO', COLUMN_DEFAULT: 'available' },
            { COLUMN_NAME: 'auto_reply_enabled', COLUMN_TYPE: 'tinyint(1)', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '0' },
            { COLUMN_NAME: 'auto_reply_busy', COLUMN_TYPE: 'varchar(500)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: DEFAULT_BUSY_MESSAGE },
            { COLUMN_NAME: 'auto_reply_away', COLUMN_TYPE: 'varchar(500)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: DEFAULT_AWAY_MESSAGE },
            { COLUMN_NAME: 'availability_version', COLUMN_TYPE: 'int unsigned', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '1' },
            { COLUMN_NAME: 'availability_updated_at', COLUMN_TYPE: 'timestamp', IS_NULLABLE: 'NO', COLUMN_DEFAULT: 'CURRENT_TIMESTAMP', EXTRA: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP' },
          ];
          const cols = overrides.userCols !== undefined ? overrides.userCols : defaultCols;
          return [cols];
        }

        if (sql.includes("TABLE_NAME = 'visitor_messages'")) {
          if (sql.includes('information_schema.STATISTICS')) {
            const defaultIdx = [
              { NON_UNIQUE: 1, SEQ_IN_INDEX: 1, COLUMN_NAME: 'session_id', SUB_PART: null, INDEX_TYPE: 'BTREE', IS_VISIBLE: 'YES' },
              { NON_UNIQUE: 1, SEQ_IN_INDEX: 2, COLUMN_NAME: 'priority', SUB_PART: null, INDEX_TYPE: 'BTREE', IS_VISIBLE: 'YES' },
            ];
            return [overrides.msgIdx !== undefined ? overrides.msgIdx : defaultIdx];
          }
          const defaultCols = [
            { COLUMN_NAME: 'priority', COLUMN_TYPE: "enum('urgent','high','normal','low')", IS_NULLABLE: 'NO', COLUMN_DEFAULT: 'normal' },
            { COLUMN_NAME: 'priority_reason', COLUMN_TYPE: 'varchar(255)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null },
            { COLUMN_NAME: 'priority_overridden', COLUMN_TYPE: 'tinyint(1)', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '0' },
            { COLUMN_NAME: 'is_auto_reply', COLUMN_TYPE: 'tinyint(1)', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '0' },
          ];
          return [overrides.msgCols !== undefined ? overrides.msgCols : defaultCols];
        }

        if (sql.includes("TABLE_NAME = 'visitor_sessions'")) {
          if (sql.includes('information_schema.STATISTICS')) {
            const defaultIdx = [
              { NON_UNIQUE: 1, SEQ_IN_INDEX: 1, COLUMN_NAME: 'session_priority', SUB_PART: null, INDEX_TYPE: 'BTREE', IS_VISIBLE: 'YES' },
              { NON_UNIQUE: 1, SEQ_IN_INDEX: 2, COLUMN_NAME: 'created_at', SUB_PART: null, INDEX_TYPE: 'BTREE', IS_VISIBLE: 'YES' },
            ];
            return [overrides.sessionIdx !== undefined ? overrides.sessionIdx : defaultIdx];
          }
          const defaultCols = [
            { COLUMN_NAME: 'session_priority', COLUMN_TYPE: "enum('urgent','high','normal','low')", IS_NULLABLE: 'NO', COLUMN_DEFAULT: 'normal' },
            { COLUMN_NAME: 'priority_overridden', COLUMN_TYPE: 'tinyint(1)', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '0' },
            { COLUMN_NAME: 'last_auto_reply_status', COLUMN_TYPE: "enum('available','busy','away')", IS_NULLABLE: 'YES', COLUMN_DEFAULT: null },
            { COLUMN_NAME: 'last_auto_reply_version', COLUMN_TYPE: 'int unsigned', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null },
          ];
          return [overrides.sessionCols !== undefined ? overrides.sessionCols : defaultCols];
        }

        return [[]];
      },
    };
  }

  await t.test('1. Valid schema passes migration 010 verification', async () => {
    const conn = makeMockSchemaConnection();
    await assert.doesNotReject(async () => {
      await verifyAiPriorityAndAvailabilitySchema(conn);
    });
  });

  await t.test('2. Rejects incorrect auto_reply_busy length (e.g. VARCHAR(255) instead of VARCHAR(500))', async () => {
    const conn = makeMockSchemaConnection({
      userCols: [
        { COLUMN_NAME: 'availability_status', COLUMN_TYPE: "enum('available','busy','away')", IS_NULLABLE: 'NO', COLUMN_DEFAULT: 'available' },
        { COLUMN_NAME: 'auto_reply_enabled', COLUMN_TYPE: 'tinyint(1)', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '0' },
        { COLUMN_NAME: 'auto_reply_busy', COLUMN_TYPE: 'varchar(255)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: DEFAULT_BUSY_MESSAGE },
        { COLUMN_NAME: 'auto_reply_away', COLUMN_TYPE: 'varchar(500)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: DEFAULT_AWAY_MESSAGE },
        { COLUMN_NAME: 'availability_version', COLUMN_TYPE: 'int unsigned', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '1' },
        { COLUMN_NAME: 'availability_updated_at', COLUMN_TYPE: 'timestamp', IS_NULLABLE: 'NO', COLUMN_DEFAULT: 'CURRENT_TIMESTAMP', EXTRA: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP' },
      ],
    });

    await assert.rejects(
      async () => {
        await verifyAiPriorityAndAvailabilitySchema(conn);
      },
      /users\.auto_reply_busy must be VARCHAR\(500\)/
    );
  });

  await t.test('3. Rejects inverted or incorrect index definition on visitor_sessions', async () => {
    const conn = makeMockSchemaConnection({
      sessionIdx: [
        { NON_UNIQUE: 1, SEQ_IN_INDEX: 1, COLUMN_NAME: 'created_at', SUB_PART: null, INDEX_TYPE: 'BTREE', IS_VISIBLE: 'YES' }, // WRONG ORDER
        { NON_UNIQUE: 1, SEQ_IN_INDEX: 2, COLUMN_NAME: 'session_priority', SUB_PART: null, INDEX_TYPE: 'BTREE', IS_VISIBLE: 'YES' },
      ],
    });

    await assert.rejects(
      async () => {
        await verifyAiPriorityAndAvailabilitySchema(conn);
      },
      /idx_visitor_sessions_priority on visitor_sessions must be a visible, non-prefix BTREE index on \(session_priority, created_at\)/
    );
  });

  await t.test('4. Rejects missing availability_version column on users', async () => {
    const conn = makeMockSchemaConnection({
      userCols: [
        { COLUMN_NAME: 'availability_status', COLUMN_TYPE: "enum('available','busy','away')", IS_NULLABLE: 'NO', COLUMN_DEFAULT: 'available' },
        { COLUMN_NAME: 'auto_reply_enabled', COLUMN_TYPE: 'tinyint(1)', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '0' },
        { COLUMN_NAME: 'auto_reply_busy', COLUMN_TYPE: 'varchar(500)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: DEFAULT_BUSY_MESSAGE },
        { COLUMN_NAME: 'auto_reply_away', COLUMN_TYPE: 'varchar(500)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: DEFAULT_AWAY_MESSAGE },
        { COLUMN_NAME: 'availability_updated_at', COLUMN_TYPE: 'timestamp', IS_NULLABLE: 'NO', COLUMN_DEFAULT: 'CURRENT_TIMESTAMP', EXTRA: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP' },
      ],
    });

    await assert.rejects(
      async () => {
        await verifyAiPriorityAndAvailabilitySchema(conn);
      },
      /users\.availability_version must be INT UNSIGNED NOT NULL DEFAULT 1/
    );
  });

  await t.test('5. Rejects missing ON UPDATE CURRENT_TIMESTAMP on users.availability_updated_at', async () => {
    const conn = makeMockSchemaConnection({
      userCols: [
        { COLUMN_NAME: 'availability_status', COLUMN_TYPE: "enum('available','busy','away')", IS_NULLABLE: 'NO', COLUMN_DEFAULT: 'available' },
        { COLUMN_NAME: 'auto_reply_enabled', COLUMN_TYPE: 'tinyint(1)', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '0' },
        { COLUMN_NAME: 'auto_reply_busy', COLUMN_TYPE: 'varchar(500)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: DEFAULT_BUSY_MESSAGE },
        { COLUMN_NAME: 'auto_reply_away', COLUMN_TYPE: 'varchar(500)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: DEFAULT_AWAY_MESSAGE },
        { COLUMN_NAME: 'availability_version', COLUMN_TYPE: 'int unsigned', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '1' },
        { COLUMN_NAME: 'availability_updated_at', COLUMN_TYPE: 'timestamp', IS_NULLABLE: 'NO', COLUMN_DEFAULT: 'CURRENT_TIMESTAMP', EXTRA: '' }, // Missing ON UPDATE
      ],
    });

    await assert.rejects(
      async () => {
        await verifyAiPriorityAndAvailabilitySchema(conn);
      },
      /users\.availability_updated_at must be TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP/
    );
  });

  await t.test('6. Rejects prefix index on visitor_messages.idx_visitor_messages_priority', async () => {
    const conn = makeMockSchemaConnection({
      msgIdx: [
        { NON_UNIQUE: 1, SEQ_IN_INDEX: 1, COLUMN_NAME: 'session_id', SUB_PART: 10, INDEX_TYPE: 'BTREE', IS_VISIBLE: 'YES' }, // SUB_PART prefix
        { NON_UNIQUE: 1, SEQ_IN_INDEX: 2, COLUMN_NAME: 'priority', SUB_PART: null, INDEX_TYPE: 'BTREE', IS_VISIBLE: 'YES' },
      ],
    });

    await assert.rejects(
      async () => {
        await verifyAiPriorityAndAvailabilitySchema(conn);
      },
      /idx_visitor_messages_priority on visitor_messages must be a visible, non-prefix BTREE index/
    );
  });

  await t.test('7. Rejects invisible index on visitor_sessions.idx_visitor_sessions_priority', async () => {
    const conn = makeMockSchemaConnection({
      sessionIdx: [
        { NON_UNIQUE: 1, SEQ_IN_INDEX: 1, COLUMN_NAME: 'session_priority', SUB_PART: null, INDEX_TYPE: 'BTREE', IS_VISIBLE: 'NO' }, // INVISIBLE
        { NON_UNIQUE: 1, SEQ_IN_INDEX: 2, COLUMN_NAME: 'created_at', SUB_PART: null, INDEX_TYPE: 'BTREE', IS_VISIBLE: 'YES' },
      ],
    });

    await assert.rejects(
      async () => {
        await verifyAiPriorityAndAvailabilitySchema(conn);
      },
      /idx_visitor_sessions_priority on visitor_sessions must be a visible, non-prefix BTREE index/
    );
  });

  await t.test('8. Rejects non-BTREE index type on visitor_messages.idx_visitor_messages_priority', async () => {
    const conn = makeMockSchemaConnection({
      msgIdx: [
        { NON_UNIQUE: 1, SEQ_IN_INDEX: 1, COLUMN_NAME: 'session_id', SUB_PART: null, INDEX_TYPE: 'HASH', IS_VISIBLE: 'YES' }, // HASH
        { NON_UNIQUE: 1, SEQ_IN_INDEX: 2, COLUMN_NAME: 'priority', SUB_PART: null, INDEX_TYPE: 'BTREE', IS_VISIBLE: 'YES' },
      ],
    });

    await assert.rejects(
      async () => {
        await verifyAiPriorityAndAvailabilitySchema(conn);
      },
      /idx_visitor_messages_priority on visitor_messages must be a visible, non-prefix BTREE index/
    );
  });

  await t.test('9. Rejects missing or wrong default on users.auto_reply_busy', async () => {
    const conn = makeMockSchemaConnection({
      userCols: [
        { COLUMN_NAME: 'availability_status', COLUMN_TYPE: "enum('available','busy','away')", IS_NULLABLE: 'NO', COLUMN_DEFAULT: 'available' },
        { COLUMN_NAME: 'auto_reply_enabled', COLUMN_TYPE: 'tinyint(1)', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '0' },
        { COLUMN_NAME: 'auto_reply_busy', COLUMN_TYPE: 'varchar(500)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: 'Wrong default text' },
        { COLUMN_NAME: 'auto_reply_away', COLUMN_TYPE: 'varchar(500)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: DEFAULT_AWAY_MESSAGE },
        { COLUMN_NAME: 'availability_version', COLUMN_TYPE: 'int unsigned', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '1' },
        { COLUMN_NAME: 'availability_updated_at', COLUMN_TYPE: 'timestamp', IS_NULLABLE: 'NO', COLUMN_DEFAULT: 'CURRENT_TIMESTAMP', EXTRA: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP' },
      ],
    });

    await assert.rejects(
      async () => {
        await verifyAiPriorityAndAvailabilitySchema(conn);
      },
      /users\.auto_reply_busy must be VARCHAR\(500\) NULL DEFAULT/
    );
  });

  await t.test('10. Rejects missing or wrong default on users.auto_reply_away', async () => {
    const conn = makeMockSchemaConnection({
      userCols: [
        { COLUMN_NAME: 'availability_status', COLUMN_TYPE: "enum('available','busy','away')", IS_NULLABLE: 'NO', COLUMN_DEFAULT: 'available' },
        { COLUMN_NAME: 'auto_reply_enabled', COLUMN_TYPE: 'tinyint(1)', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '0' },
        { COLUMN_NAME: 'auto_reply_busy', COLUMN_TYPE: 'varchar(500)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: DEFAULT_BUSY_MESSAGE },
        { COLUMN_NAME: 'auto_reply_away', COLUMN_TYPE: 'varchar(500)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null },
        { COLUMN_NAME: 'availability_version', COLUMN_TYPE: 'int unsigned', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '1' },
        { COLUMN_NAME: 'availability_updated_at', COLUMN_TYPE: 'timestamp', IS_NULLABLE: 'NO', COLUMN_DEFAULT: 'CURRENT_TIMESTAMP', EXTRA: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP' },
      ],
    });

    await assert.rejects(
      async () => {
        await verifyAiPriorityAndAvailabilitySchema(conn);
      },
      /users\.auto_reply_away must be VARCHAR\(500\) NULL DEFAULT/
    );
  });
});
