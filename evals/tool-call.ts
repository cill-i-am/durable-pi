import { z } from "zod"

// Match z.json() at runtime, but give recursion an explicit input/output boundary.
// tsrs 0.18 cannot instantiate ZodJSONSchema's recursive union inside a record.
const json: z.ZodType<z.core.util.JSONType, z.core.util.JSONType> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(json),
    z.record(z.string(), json),
  ])
)

export const toolCall = z.object({
  name: z.string(),
  arguments: z.record(z.string(), json),
})
