import { spawnSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { expect, test } from "vitest"

test("the CI lint entry point rejects lifecycle boundary violations", () => {
  const directory = realpathSync(
    mkdtempSync(resolve(tmpdir(), "architecture-conformance-"))
  )
  const root = process.cwd()
  mkdirSync(resolve(directory, "src"))
  symlinkSync(
    resolve(root, "node_modules"),
    resolve(directory, "node_modules"),
    "dir"
  )
  // Use the actual CI config/rules in an isolated project. Temporary source in
  // the real src tree races concurrent typecheck/lint program discovery.
  writeFileSync(
    resolve(directory, "oxlint.config.ts"),
    readFileSync(resolve(root, "oxlint.config.ts"), "utf8").replace(
      '"./scripts/architecture-rules.mjs"',
      JSON.stringify(resolve(root, "scripts/architecture-rules.mjs"))
    )
  )
  writeFileSync(resolve(directory, "package.json"), '{"type":"module"}')
  writeFileSync(
    resolve(directory, "tsconfig.json"),
    '{"compilerOptions":{"target":"ES2022","module":"ESNext","moduleResolution":"bundler","strict":true,"skipLibCheck":true},"include":["src"]}'
  )
  const file = resolve(directory, "src/reference.machine.ts")
  const lint = (code: string) => {
    writeFileSync(file, code)
    return spawnSync(
      resolve(root, "node_modules/.bin/oxlint"),
      ["--config", "oxlint.config.ts", "--deny-warnings", file],
      { encoding: "utf8", cwd: directory }
    )
  }
  try {
    const valid = lint(
      'import { setupEffect } from "@xstate/effect"; export const machine = setupEffect({}).createMachine({ initial: "idle", states: { idle: {} } })'
    )
    expect(valid.status, valid.stdout + valid.stderr).toBe(0)
    for (const code of [
      'export { createActor as start } from "xstate"',
      'import * as XS from "xstate"; export const start = () => XS.createActor({})',
      'export * from "@/storage/sqlite"',
      'export { Effect } from "effect"; import { Effect as Fx } from "effect"; export const start = () => Fx.runSync(Fx.void)',
    ]) {
      const invalid = lint(code)
      expect(invalid.status, code + invalid.stdout + invalid.stderr).not.toBe(0)
      expect(invalid.stdout + invalid.stderr).toContain("architecture")
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
