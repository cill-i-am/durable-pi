import { Linter } from "eslint"
import { expect, it } from "vitest"
import { domainBoundaries } from "../scripts/architecture-rules.mjs"

const check = (code: string, filename = "/project/src/routines/service.js") =>
  new Linter({ cwd: "/project" }).verify(
    code,
    [
      {
        plugins: { architecture: { rules: { boundaries: domainBoundaries } } },
        rules: { "architecture/boundaries": "error" },
      },
    ],
    { filename }
  )

it("enforces resolved relative, alias, re-export and dynamic import boundaries", () => {
  for (const code of [
    'import { x } from "./adapters/sqlite"',
    'import { x } from "@/routines/adapters/sqlite"',
    'import { x } from "../webhooks/adapters/sqlite"',
    'export { x } from "../agent/worker"',
    'export * from "@/storage/sqlite"',
    'import("cloudflare:workers")',
    'import { x } from "@earendil-works/pi-durable"',
    'import { x } from "@effect/sql-sqlite-do"',
    'import { x } from "node:fs"',
    'import { x } from "../terminal/worker"',
    'import { x } from "@/delegation/worker.ts"',
    'import { x } from "@/env"',
    'import { x } from "../auth/server"',
    'import { x } from "../../alchemy.run"',
    'export * from "../../stacks/github"',
    "const socket = response.webSocket",
    'import { Effect } from "effect"; Effect.runPromise(program)',
    "if (error instanceof DomainFailure) recover(error)",
  ])
    expect(check(code)).toHaveLength(1)
  expect(
    check(
      'import { Routines } from "./service"; import { Effect } from "effect"; Effect.map(program, f)'
    )
  ).toHaveLength(0)
})

it("rejects aliased, namespace and direct Effect runners and runtime construction", () => {
  for (const code of [
    'import { Effect as Fx } from "effect"; Fx.runPromise(program)',
    'import * as Fx from "effect/Effect"; Fx.runSync(program)',
    'import { runPromise as execute } from "effect/Effect"; execute(program)',
    'import * as E from "effect"; E.Effect.runFork(program)',
    'import { ManagedRuntime as Runtime } from "effect"; Runtime.make(layer)',
    'import * as Runtime from "effect/ManagedRuntime"; Runtime.make(layer)',
    'import { make as runtime } from "effect/ManagedRuntime"; runtime(layer)',
    'import * as E from "effect"; E.ManagedRuntime.make(layer)',
    'import { Effect as Fx } from "effect"; Fx["runPromise"](program)',
  ])
    expect(check(code), code).toHaveLength(1)
})

it("allows composed Effects and does not confuse shadowed local objects with imports", () => {
  for (const code of [
    'import { Effect as Fx } from "effect"; Fx.map(program, f)',
    'import * as E from "effect"; E.Effect.gen(body)',
    'import * as Fx from "effect/Effect"; Fx.scoped(program)',
    'import { Effect as Fx } from "effect"; function f(Fx) { Fx.runPromise() }',
    'import { ManagedRuntime as R } from "effect"; function f(R) { R.make() }',
    'import { Effect } from "effect"; function f(Effect) { Effect.runPromise() }',
  ])
    expect(check(code), code).toHaveLength(0)
})

it("keeps shared mechanisms independent of feature contracts", () => {
  for (const code of [
    'export * from "../conversations/contracts"',
    'import { AgentId } from "@/agents/domain"',
  ])
    expect(check(code, "/project/src/shared/contracts.js")).toHaveLength(1)
  expect(
    check(
      'import { nativeOperation } from "./interop"; import { Effect } from "effect"',
      "/project/src/shared/http.js"
    )
  ).toHaveLength(0)
})
