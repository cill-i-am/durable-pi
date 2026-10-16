# Persistence with Drizzle and Effect

Application-owned SQLite queries use Drizzle builders and the first-party Effect v4 drivers. D1 account lookups use Alchemy's Drizzle D1 integration. Better Auth retains its supported Drizzle adapter. Pi owns its journal, schema, and recovery protocol.

## Transactions

Each actor creates one scoped database before constructing its feature stores. `Sqlite.use` executes Drizzle query Effects and coordinates them with Pi storage operations. `Sqlite.transaction` owns each complete application transaction. A nested transaction joins its existing owner.

Durable Object transactions must finish synchronously. They can compose local Drizzle Effects, pure decisions, and caller Context. Network calls, timers, Promise boundaries, and asynchronous cleanup belong outside the transaction. The stock Effect Drizzle DO transaction method is intentionally absent from the exposed database type: it can leave suspended work running after native rollback. The guarded adapter revokes query access before rollback, interrupts suspended callbacks, and joins their cleanup. A rejected callback retains its full Cause.

PiHarness has a small pinned dependency patch adding `coordinateStorage`. Both its retained session store and the harness factory receive the same decorated store. Complete Pi operations share the actor's database queue; its journal implementation stays SDK-owned. Do not open a second uncoordinated Pi store. SDK synchronous Lifecycle and MCP writes cannot interleave with bounded application transactions.

Node SQLite uses its first-party scoped Effect driver, including native asynchronous transactions. Feature stores expose Effects on every backend; domain decisions remain independent of driver types. Synchronous SDK model-sizing getters use a pinned snapshot refreshed before each conversation pump; authorization always reads fresh state through Effects.

## Queries and migrations

Use typed table definitions in each feature's `adapters/schema.ts`. Complete handwritten SQL statements and `sql.raw` are prohibited in application queries. Small typed SQLite expressions cover JSON fields, arithmetic, and exact substring matching. Generated migration DDL and deliberate fault injection in test fixtures are infrastructure exceptions.

Run `pnpm db:generate:agent` after changing an agent schema, then commit the generated migration and manifest together. Never rewrite committed migration history. `pnpm db:check:agent` verifies that the runtime manifest matches generated files. Auth retains its separate D1 migration history.

The first agent migration is a fresh baseline. An existing unversioned application schema fails initialization without changing its data. Before deploying this baseline against those actors, explicitly reset each affected actor's complete durable storage, including Pi journal and lifecycle state; partial deletion would leave inconsistent recovery state. No startup path wipes data automatically. Auth D1 has a separate migration history and is outside this reset.

Failed bootstrap rolls back generated DDL and migration history together. Reactivation verifies applied migration IDs, order, and checksums with two reads. Run `migrateSqlite(db, { audit: true })` to compare the owned tables and indexes against the complete generated schema.

## Schema design

Following [PlanetScale's Postgres schema guidance](https://github.com/planetscale/database-skills/tree/main/skills/postgres), tables have explicit non-null primary keys, checked states and counters, and local foreign keys with deliberate deletion behavior. Referencing columns have indexes. Composite indexes follow actual filters and ordering. SQLite text primary keys use table-level declarations because this Drizzle Kit release omits `NOT NULL` for inline primary keys.

Replay, pagination, and archive order use explicit integer sequence columns rather than implicit SQLite rowids. Append-only sequence and history keys use autoincrement to avoid reusing a deleted high-water mark. Public business IDs remain stable unique keys. Related records are inserted after their parent within the same application transaction. Foreign keys stop at actor and SDK ownership boundaries.

Frequently filtered fields have typed columns. Immutable domain snapshots remain validated JSON payloads, with database JSON checks where the field contract permits them. Operation cancellation fences intentionally retain their existing empty input sentinel. These are SQLite schemas: future Postgres adapters must choose their own types, generated keys, and query expressions.

## Verification

`pnpm test` covers feature behavior, transaction rollback, authorization, replay, imports, backups, schema constraints, migration drift, and clean bootstrap. `pnpm test:drizzle-runtime` exercises real Durable Object SQLite, SDK coordination, cancellation, escaped queries, suspension, restart, and lost acknowledgments. `pnpm test:communication-runtime` exercises the integrated workers and native Pi harness.

A future shared Postgres store can implement the affected domain persistence contracts with Drizzle's Effect Postgres driver and Alchemy's integration. SQLite schemas and driver expressions remain in adapters. Moving shared data also requires explicit transaction and outbox decisions; changing an ORM does not make cross-database commits atomic.
