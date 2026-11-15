# MySQL integration test safety

The MySQL integration suite creates and drops temporary schemas named
`parkx_it_<12 lowercase hex characters>`. It is destructive to those schemas.
Run it only against a verified disposable MySQL server with a dedicated account
named `parkx_test_*`, with privileges limited to creating, using, and dropping
the generated test schemas. Never provide Railway or production credentials.

The test suite deliberately does not load `.env`. Migration modules (`src/migrate.js`) export migration and verification functions without loading `.env` side effects, ensuring test processes do not inherit local application `.env` credentials on import. Environment loading occurs explicitly only when executing the migration CLI directly (`npm run migrate` or `node src/migrate.js`). To run the integration suite against a verified disposable server, explicitly set:

```sh
RUN_MYSQL_INTEGRATION=1 \
TEST_DB_ALLOW_CREATE_DROP=I_ACCEPT_DISPOSABLE_DATABASES \
TEST_DB_HOST=127.0.0.1 \
TEST_DB_PORT=3306 \
TEST_DB_USER=parkx_test_local \
TEST_DB_PASSWORD='<dedicated test-only password>' \
npm run test:mysql
```

The harness rejects known Railway hostnames and any test host, username, or
password that matches configured application or migration credentials. These
checks reduce accidental targeting; operators must still verify the server and
account are disposable before setting the explicit acknowledgement variable.

The state-transition tests launch competing HTTP requests with `Promise.all`
and inspect persisted outcomes. That demonstrates concurrent request initiation,
but does not guarantee a deterministic overlap at the exact database statement
boundary; the MySQL server may serialize scheduling before either transaction
reaches its update. Treat DB-level overlap as unproven unless a run adds and
verifies a database synchronization mechanism on the disposable server.
