import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import session from 'express-session';
import { createApp } from '../src/index.js';

const origin = 'http://localhost:5173';
const env = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-secret-that-is-at-least-32-bytes-long',
  ALLOWED_ORIGINS: origin,
};

function createMockPool() {
  const users = [
    { id: 1, full_name: 'Owner Alice', email: 'alice@parkx.ai', password_hash: 'hash1', created_at: new Date().toISOString() },
    { id: 2, full_name: 'Owner Bob', email: 'bob@parkx.ai', password_hash: 'hash2', created_at: new Date().toISOString() },
  ];
  const vehicles = [];
  const qrCodes = [];
  let vehicleIdCounter = 1;
  let qrIdCounter = 1;

  const pool = {
    users,
    vehicles,
    qrCodes,
    async query(sql, params = []) {
      if (sql.startsWith('SELECT 1')) return [[{ 1: 1 }]];

      // List vehicles for user
      if (sql.includes('FROM vehicles v') && sql.includes('WHERE v.user_id = ?')) {
        const userId = Number(params[0]);
        const userVehicles = vehicles
          .filter((v) => v.user_id === userId)
          .map((v) => {
            const activeQr = qrCodes.find((q) => q.vehicle_id === v.id && q.status === 'active');
            return {
              ...v,
              active_qr_id: activeQr ? activeQr.id : null,
              active_qr_status: activeQr ? activeQr.status : null,
              active_qr_created_at: activeQr ? activeQr.created_at : null,
            };
          });
        return [userVehicles, []];
      }

      // Check duplicate registration_number
      if (sql.includes('SELECT id FROM vehicles WHERE registration_number = ? LIMIT 1')) {
        const reg = params[0];
        const found = vehicles.find((v) => v.registration_number.toUpperCase() === reg.toUpperCase());
        return [found ? [{ id: found.id }] : [], []];
      }

      // Check duplicate registration_number excluding id
      if (sql.includes('WHERE registration_number = ? AND id != ?')) {
        const [reg, vId] = params;
        const found = vehicles.find((v) => v.registration_number.toUpperCase() === reg.toUpperCase() && v.id !== Number(vId));
        return [found ? [{ id: found.id }] : [], []];
      }

      // Select single vehicle with user_id check (ownership check)
      if (sql.includes('FROM vehicles WHERE id = ? AND user_id = ?')) {
        const [vId, uId] = params;
        const found = vehicles.find((v) => v.id === Number(vId) && v.user_id === Number(uId));
        return [found ? [found] : [], []];
      }

      // Select single vehicle by id
      if (sql.includes('FROM vehicles WHERE id = ?')) {
        const vId = Number(params[0]);
        const found = vehicles.find((v) => v.id === vId);
        return [found ? [found] : [], []];
      }

      // Insert vehicle
      if (sql.includes('INSERT INTO vehicles')) {
        const [user_id, registration_number, vehicle_type, vehicle_model, color] = params;
        const row = {
          id: vehicleIdCounter++,
          user_id: Number(user_id),
          registration_number,
          vehicle_type,
          vehicle_model,
          color,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        vehicles.push(row);
        return [{ insertId: row.id }, []];
      }

      // Update vehicle
      if (sql.includes('UPDATE vehicles')) {
        const [newReg, newType, newModel, newColor, vId, uId] = params;
        const found = vehicles.find((v) => v.id === Number(vId) && v.user_id === Number(uId));
        if (found) {
          found.registration_number = newReg;
          found.vehicle_type = newType;
          found.vehicle_model = newModel;
          found.color = newColor;
          found.updated_at = new Date().toISOString();
        }
        return [{ affectedRows: found ? 1 : 0 }, []];
      }

      // Delete vehicle
      if (sql.includes('DELETE FROM vehicles WHERE id = ? AND user_id = ?')) {
        const [vId, uId] = params;
        const idx = vehicles.findIndex((v) => v.id === Number(vId) && v.user_id === Number(uId));
        if (idx !== -1) vehicles.splice(idx, 1);
        return [{ affectedRows: idx !== -1 ? 1 : 0 }, []];
      }

      // QR codes queries
      if (sql.includes('INSERT INTO qr_codes')) {
        const [vehicle_id, token_hash, status] = params;
        const row = {
          id: qrIdCounter++,
          vehicle_id: Number(vehicle_id),
          token_hash,
          status,
          created_at: new Date().toISOString(),
          revoked_at: null,
        };
        qrCodes.push(row);
        return [{ insertId: row.id }, []];
      }

      if (sql.includes('SELECT id, status, created_at, revoked_at FROM qr_codes WHERE vehicle_id = ?')) {
        const vId = Number(params[0]);
        const qrs = qrCodes.filter((q) => q.vehicle_id === vId);
        return [qrs, []];
      }

      if (sql.includes('UPDATE qr_codes SET status = \'revoked\'')) {
        const vId = Number(params[0]);
        for (const q of qrCodes) {
          if (q.vehicle_id === vId && q.status === 'active') {
            q.status = 'revoked';
            q.revoked_at = new Date().toISOString();
          }
        }
        return [{ affectedRows: 1 }, []];
      }

      if (sql.includes('DELETE FROM qr_codes WHERE vehicle_id = ?')) {
        const vId = Number(params[0]);
        for (let i = qrCodes.length - 1; i >= 0; i--) {
          if (qrCodes[i].vehicle_id === vId) qrCodes.splice(i, 1);
        }
        return [{ affectedRows: 1 }, []];
      }

      throw new Error(`Unhandled mock query: ${sql}`);
    },

    async getConnection() {
      return {
        query: (...args) => pool.query(...args),
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
      };
    },
  };

  return pool;
}

const servers = [];
async function createHarness(options = {}) {
  const pool = options.pool || createMockPool();
  const store = new session.MemoryStore();
  const app = createApp({
    env,
    pool,
    store,
  });
  const server = app.listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return { baseUrl, pool };
}

after(() => {
  for (const server of servers) {
    server.close();
  }
});

test('Vehicle Management API Suite', async (t) => {
  const { baseUrl } = await createHarness();

  await t.test('Unauthenticated requests are rejected with 401', async () => {
    const resGet = await fetch(`${baseUrl}/api/vehicles`);
    assert.equal(resGet.status, 401);

    const resPost = await fetch(`${baseUrl}/api/vehicles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ registration_number: 'TEST-01' }),
    });
    assert.equal(resPost.status, 401);

    const resDetail = await fetch(`${baseUrl}/api/vehicles/1`);
    assert.equal(resDetail.status, 401);

    const resPatch = await fetch(`${baseUrl}/api/vehicles/1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ color: 'Obsidian Black' }),
    });
    assert.equal(resPatch.status, 401);

    const resDelete = await fetch(`${baseUrl}/api/vehicles/1`, {
      method: 'DELETE',
      headers: { Origin: origin },
    });
    assert.equal(resDelete.status, 401);
  });
});
