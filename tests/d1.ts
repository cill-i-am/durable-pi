import type { DatabaseSync, SQLInputValue } from "node:sqlite"

/** Run the production D1 adapter SQL against native SQLite. This transport
 * implements only D1's statement contract; authorization is production code. */
export function d1(sql: DatabaseSync) {
  class Statement {
    constructor(
      readonly query: string,
      readonly params: SQLInputValue[] = []
    ) {}
    bind(...params: SQLInputValue[]) {
      return new Statement(this.query, params)
    }
    async all() {
      return {
        success: true,
        results: sql.prepare(this.query).all(...this.params),
        meta: {},
      }
    }
    async first() {
      return sql.prepare(this.query).get(...this.params) ?? null
    }
    async raw() {
      const statement = sql.prepare(this.query)
      statement.setReturnArrays(true)
      return statement.all(...this.params)
    }
    async run() {
      return this.all()
    }
  }
  return {
    prepare: (query: string) => new Statement(query),
    batch: async (statements: Statement[]) => {
      sql.exec("BEGIN")
      try {
        const results = await Promise.all(
          statements.map((statement) => statement.all())
        )
        sql.exec("COMMIT")
        return results
      } catch (cause) {
        sql.exec("ROLLBACK")
        throw cause
      }
    },
  } as unknown as D1Database
}
