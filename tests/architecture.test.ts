import { RuleTester } from "oxlint/plugins-dev"
import { describe, it } from "vitest"

import {
  domainBoundaries,
  effectMachines,
} from "../scripts/architecture-rules.mjs"

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const service = "/project/src/routines/service.ts"
const shared = "/project/src/shared/contracts.ts"

new RuleTester().run("architecture/boundaries", domainBoundaries, {
  valid: [
    ...[
      'import { Effect as Fx } from "effect"; Fx.map(program, f)',
      'import * as E from "effect"; E.Effect.gen(body)',
      'import * as Fx from "effect/Effect"; Fx.scoped(program)',
      'import { Effect as Fx } from "effect"; function f(Fx) { Fx.runPromise() }',
      'import { ManagedRuntime as R } from "effect"; function f(R) { R.make() }',
      'import { Effect } from "effect"; function f(Effect) { Effect.runPromise() }',
      'import { Routines } from "./service"; import { Effect } from "effect"; Effect.map(program, f)',
    ].map((code) => ({ code, filename: service })),
    {
      code: 'import { nativeOperation } from "./interop"; import { Effect } from "effect"',
      filename: shared,
    },
  ],
  invalid: [
    ...[
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
    ].map((code) => ({
      code,
      filename: service,
      errors: [{ messageId: "infrastructure" }],
    })),
    ...[
      'import { Effect } from "effect"; Effect.runPromise(program)',
      'import { Effect as Fx } from "effect"; Fx.runPromise(program)',
      'import * as Fx from "effect/Effect"; Fx.runSync(program)',
      'import { runPromise as execute } from "effect/Effect"; execute(program)',
      'import * as E from "effect"; E.Effect.runFork(program)',
      'import { ManagedRuntime as Runtime } from "effect"; Runtime.make(layer)',
      'import * as Runtime from "effect/ManagedRuntime"; Runtime.make(layer)',
      'import { make as runtime } from "effect/ManagedRuntime"; runtime(layer)',
      'import * as E from "effect"; E.ManagedRuntime.make(layer)',
      'import { Effect as Fx } from "effect"; Fx["runPromise"](program)',
    ].map((code) => ({
      code,
      filename: service,
      errors: [{ messageId: "runner" }],
    })),
    {
      code: "if (error instanceof DomainFailure) recover(error)",
      filename: service,
      errors: [{ messageId: "errorIdentity" }],
    },
    ...[
      'export * from "../conversations/contracts"',
      'import { AgentId } from "@/agents/domain"',
    ].map((code) => ({
      code,
      filename: shared,
      errors: [{ messageId: "sharedDependency" }],
    })),
  ],
})

new RuleTester().run("architecture/effect-machines", effectMachines, {
  valid: [
    'import { transition, initialTransition } from "xstate"; transition(machine, state, event)',
    'import type { Actor } from "xstate"',
    'export type { Actor } from "xstate"',
    'export { transition as decide } from "xstate"',
    'import { createEffectActor } from "@xstate/effect"; createEffectActor(machine)',
    'import { useSelector } from "@xstate/react"; useSelector(actor, select)',
    "const project = (record) => ({ status: record.status }); project(record)",
    'import * as XS from "xstate"; function f(XS) { XS.createActor(machine) }',
  ]
    .map((code) => ({ code, filename: service }))
    .concat([
      {
        code: 'import { setupEffect as define } from "@xstate/effect"; define({}).createMachine({})',
        filename: "/project/src/features/files/preparation.machine.ts",
      },
    ]),
  invalid: [
    ...[
      'import { createActor as start } from "xstate"; start(machine)',
      'import * as XS from "xstate"; XS.createActor(machine)',
      'import * as XS from "xstate"; XS["createActor"](machine)',
      'import { Actor } from "xstate"; new Actor(machine)',
      'import { setup } from "xstate"; setup({})',
      'export { createActor as start } from "xstate"',
      'export * from "xstate"',
      'import("xstate")',
      'import { useMachine } from "@xstate/react"; useMachine(machine)',
      'import { useActorRef as start } from "@xstate/react"; start(machine)',
    ].map((code) => ({
      code,
      filename: service,
      errors: [{ messageId: "runtime" }],
    })),
    {
      code: 'import { setupEffect as define } from "@xstate/effect"; define({}).createMachine({})',
      filename: service,
      errors: [{ messageId: "location" }],
    },
  ],
})
