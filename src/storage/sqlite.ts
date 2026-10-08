/** Synchronous driver boundary shared by the host and SQLite adapters. */
export type Sqlite = {
  all: <T>(query: string, ...bindings: (string | number | null)[]) => T[]
  run: (query: string, ...bindings: (string | number | null)[]) => void
  transaction: <T>(body: () => T) => T
}
