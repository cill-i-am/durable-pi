import { SqlError, UnknownError } from "effect/sql/SqlError"

export const sqliteFailure = (message: string) =>
  new SqlError({
    reason: new UnknownError({
      cause: new Error(message),
      operation: "synthetic storage completion",
      message,
    }),
  })
