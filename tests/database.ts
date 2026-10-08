import { DatabaseSync } from "node:sqlite"
import type { Sqlite } from "../src/storage/sqlite"

export function database(): Sqlite {
  const sql = new DatabaseSync(":memory:")
  return {
    all: <T>(q: string, ...args: (string | number | null)[]) =>
      sql.prepare(q).all(...args) as T[],
    run: (q, ...args) => {
      sql.prepare(q).run(...args)
    },
    transaction: (body) => {
      sql.exec("SAVEPOINT operation")
      try {
        const result = body()
        sql.exec("RELEASE operation")
        return result
      } catch (e) {
        sql.exec("ROLLBACK TO operation")
        sql.exec("RELEASE operation")
        throw e
      }
    },
  }
}
