# ParkX authentication server setup

## Environment

Copy `.env.example` to `.env` and set `SESSION_SECRET` to a cryptographically random value:

```sh
openssl rand -hex 32
```

Set `ALLOWED_ORIGINS` to a comma-separated list of exact browser origins, without paths or trailing slashes. For local Vite development use `http://localhost:5173`. The server rejects startup if the session secret or origin list is missing or invalid. Do not commit `.env`.

For production, set `NODE_ENV=production`, `DB_USER` and `DB_PASSWORD` to a dedicated runtime database account, and `TRUST_PROXY_HOPS` to the number of trusted reverse proxies in front of Express (commonly `1` when deployed behind one TLS-terminating proxy). The production cookie is Secure and HttpOnly. The default SameSite policy is Strict; set `COOKIE_SAME_SITE=Lax` only if the deployment's navigation flow requires it. `None` is accepted only in production and still uses Secure cookies.

## Database migrations

Create the database, then run the versioned migrations before starting the API:

```sh
cd server
npm run migrate
```

The migration runner applies files in `migrations/` once and records them in `schema_migrations`. On an existing deployment, it creates missing tables, normalizes existing emails to lowercase/trimmed form, and adds a unique email index. Before migration 003, it checks for accounts that would collide after normalization and stops with the conflicting addresses; resolve those records manually, then rerun the migration. MySQL schema changes are not all transactional, so inspect the database after an interrupted migration before retrying.

Use a separate schema migration account in production (`MIGRATION_DB_USER` / `MIGRATION_DB_PASSWORD`) with the required CREATE, ALTER, INDEX, SELECT, INSERT, and UPDATE permissions on `parkx_db`. The runtime `DB_USER` should have only SELECT, INSERT, UPDATE, and DELETE on `users` and `sessions`; it does not need schema migration privileges. Do not use MySQL `root` for the application.

The existing deployment's `users` table must have compatible `id`, `full_name`, `email`, `password_hash`, and `created_at` columns. Verify that layout before applying migrations to a legacy database; these migrations do not rename unknown legacy columns.

Migration 004 uses `BIGINT UNSIGNED` for `vehicles.user_id` on fresh installs. Migration 005 upgrades databases that already applied the earlier 004 definition, canonicalizes existing registration values, and adds a nullable unique active-pass key. Migration 006 tightens the QR CHECK constraint to explicitly require a non-null active key, since MySQL accepts CHECK expressions that evaluate to `NULL`. Apply migrations through `npm run migrate`; the runner handles migrations 005 and 006 with schema inspection and performs only missing operations, while their SQL files retain the versioned DDL for history. MySQL DDL is not transactional, so the runner validates existing definitions and resumes partially applied migrations. It stops before adding constraints if registration normalization would create duplicates or a vehicle has multiple active passes; resolve those records deliberately before retrying. Registration input is deliberately scoped to ASCII letters and digits with spaces and hyphens as optional separators. The canonical stored value is uppercase with spaces and hyphens removed. This is an opaque registration identifier policy, not validation against any country's plate format; other scripts, punctuation, and Unicode characters are rejected.

## Tests

Run `npm test` from `server/` for unit/API tests. Run `npm run test:mysql` with a MySQL account that can create and drop databases for isolated integration tests. That suite creates randomly named `parkx_it_*` schemas and removes only those schemas after completion. Use a staging environment to verify the MySQL-backed session table and runtime grants before production rollout.

QR tokens are bearer credentials in `/v/<token>` paths. The application sets `Referrer-Policy: no-referrer`, and the static page avoids loading Google Fonts on those paths. Configure every reverse proxy, CDN, web server, analytics product, and error tracker to redact the token segment in `/v/<token>` from access/error logs and avoid analytics or third-party scripts on token-bearing pages. This repository has no deployment proxy configuration, so that log redaction must also be applied in deployment infrastructure.
