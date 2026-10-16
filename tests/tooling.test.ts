import { spawnSync } from "node:child_process"
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { Schema } from "effect"
import { format } from "oxfmt"
import { expect, it } from "vitest"

import formatting from "../oxfmt.config"

const root = fileURLToPath(new URL("../", import.meta.url))
const Result = Schema.Struct({
  diagnostics: Schema.Array(
    Schema.Struct({ code: Schema.String, filename: Schema.String })
  ),
})
const branches = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => `if (n === ${index}) return ${index}`
  ).join(";\n")

it("enforces the real tooling contracts while accepting Effect classes and complexity 20", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "durable-pi-tooling-"))
  )
  const sources: Record<string, string> = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        skipLibCheck: true,
        noEmit: true,
      },
      include: ["src/**/*.ts"],
    }),
    "oxlint.config.ts": `import base from ${JSON.stringify(pathToFileURL(join(root, "oxlint.config.ts")).href)}
export default {...base, jsPlugins: [${JSON.stringify(join(root, "scripts/architecture-rules.mjs"))}, "oxlint-plugin-effect/plugin"]}`,
    "src/shared/valid.ts": `import { Context, Effect, Schema } from "effect"
export class Failure extends Schema.TaggedError<Failure>()("Failure", {message: Schema.String}) {}
export class Value extends Schema.Class<Value>("Value")({name: Schema.String}) {}
export class Service extends Context.Service<Service, {readonly value: string}>()("probe/Service") {}
export const program = Effect.gen(function* () { return yield* Effect.succeed(new Value({name: "safe"})) })
export const bounded = (values: readonly string[]) => Effect.forEach(values, () => Effect.void, {concurrency: 4})
export function atLimit(n: number) { ${branches(19)}; return -1 }`,
    "src/shared/invalid.ts": `import { Effect } from "effect"
export const floating = Effect.gen(function* () { Effect.succeed(1); return 1 })
export const unbounded = (values: readonly string[]) => Effect.forEach(values, () => Effect.void, {concurrency: "unbounded"})
export const unknownFailure = Effect.gen(function* () { return yield* Effect.fail<unknown>("bad") })
export const unsafe = JSON.parse("{}").missing
export function overLimit(n: number) { ${branches(20)}; return -1 }`,
    "src/shared/a.ts": `import { b } from "./b"; export const a = (): number => b()`,
    "src/shared/b.ts": `import { a } from "./a"; export const b = (): number => a()`,
    "src/agent/host.ts": `export const value = 1`,
    "src/memory/invalid.ts": `import {value} from "../agent/host"; export const leaked = value`,
  }
  try {
    await symlink(
      join(root, "node_modules"),
      join(directory, "node_modules"),
      "dir"
    )
    await Promise.all(
      Object.entries(sources).map(async ([name, contents]) => {
        const path = join(directory, name)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, contents)
      })
    )
    const lint = spawnSync(
      join(root, "node_modules/.bin/oxlint"),
      [
        "--config",
        join(directory, "oxlint.config.ts"),
        "--threads",
        "2",
        "--format",
        "json",
        "src",
      ],
      { cwd: directory, encoding: "utf8", timeout: 15000 }
    )
    expect(lint.error).toBeUndefined()
    expect(lint.stderr).toBe("")
    expect(lint.status).toBe(1)
    const { diagnostics } = Schema.decodeUnknownSync(Result)(
      JSON.parse(lint.stdout)
    )
    expect(
      diagnostics.filter(
        (finding) =>
          finding.filename.endsWith("valid.ts") &&
          !finding.filename.endsWith("invalid.ts")
      )
    ).toEqual([])
    expect(diagnostics.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "eslint(complexity)",
        "effecttsgo(floating-effect)",
        "effecttsgo(any-unknown-in-error-context)",
        "effect(noUnboundedConcurrency)",
        "typescript(no-unsafe-member-access)",
        "architecture(boundaries)",
        "eslint(no-restricted-imports)",
        "import(no-cycle)",
      ])
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 20000)

it("orders imports and utility classes while preserving side-effect import order", async () => {
  const result = await format(
    "tooling-contract.tsx",
    `import "./z.css"
import "./a.css"
import {z} from "./z"
import {a} from "./a"
export const view = <div className="text-sm p-4 flex" />
export const classes = cn("text-sm p-4 flex")
export const variants = cva("text-sm p-4 flex")
`,
    {
      ...formatting,
      sortTailwindcss: {
        ...formatting.sortTailwindcss,
        stylesheet: join(root, "src/styles.css"),
      },
    }
  )
  expect(result.errors).toEqual([])
  expect(result.code.indexOf('"./z.css"')).toBeLessThan(
    result.code.indexOf('"./a.css"')
  )
  expect(result.code.indexOf('from "./a"')).toBeLessThan(
    result.code.indexOf('from "./z"')
  )
  expect(result.code).toContain('className="flex p-4 text-sm"')
  expect(result.code).toContain('cn("flex p-4 text-sm")')
  expect(result.code).toContain('cva("flex p-4 text-sm")')
})
