# Pi upgrade fixture

`pi-1.4-upgrade.json` is a synthetic SQLite export produced using the published Pi Durable, Pi AI and Chord 1.4.0 packages. It contains every application-created table, row and explicit index. It contains no account credentials or user data.

The old harness completed `legacy-completed` with one `record` tool execution and a `receipt-1` result. A second submission, `legacy-waiting`, was closed during its model request. The fixture therefore exercises a retained completed receipt and an older generation/live-document version on upgrade. `pi-upgrade.test.ts` imports it into a fresh database and opens that database with the current SDK. Preserve the old fixture when future releases change their serialization; regenerating it with the current SDK would remove the migration proof.
