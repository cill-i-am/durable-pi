import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: ["./src/**/adapters/schema.ts", "./src/storage/migration-schema.ts"],
  out: "./migrations/agent",
  dialect: "sqlite",
})
