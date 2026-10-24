import { it } from "@effect/vitest"
import { send } from "@xstate/effect"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { expect } from "vitest"

import { homeAgentId, type AgentProfile } from "../src/agents/contracts"
import { makeAgentArchive } from "../src/features/agents/agent-archive-owner"
import { makeAgentCatalog } from "../src/features/agents/agent-catalog-owner"
import { makeAgentEditor } from "../src/features/agents/agent-editor-owner"
import { makeAgentStatuses } from "../src/features/agents/agent-statuses-owner"

const profile: AgentProfile = {
  id: homeAgentId,
  slug: "home",
  name: "Home",
  instructions: "",
  status: "active",
  revision: 1,
  createdAt: "today",
  updatedAt: "today",
}

for (const kind of ["editor", "catalog", "archive", "statuses"] as const)
  it.effect(
    `${kind} joins and retains an interrupted native cleanup failure without a defect`,
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const entered = yield* Deferred.make<void>()
        const aborted = yield* Deferred.make<void>()
        let reject!: (cause: unknown) => void
        let callbacks = 0
        let listeners = 0
        const request = (signal: AbortSignal) =>
          new Promise<never>((_resolve, fail) => {
            reject = fail
            signal.addEventListener(
              "abort",
              () => {
                Deferred.doneUnsafe(aborted, Effect.void)
              },
              { once: true }
            )
            Deferred.doneUnsafe(entered, Effect.void)
          })
        const owner = yield* Effect.gen(function* () {
          switch (kind) {
            case "editor": {
              const editor = yield* makeAgentEditor(
                { id: homeAgentId, agent: profile },
                {
                  save: (_input, signal) => request(signal),
                  reconcile: async () => {
                    callbacks++
                  },
                  close: () => {
                    callbacks++
                  },
                }
              )
              yield* send(editor.actor, { type: "SAVE" })
              return editor
            }
            case "archive": {
              const archive = yield* makeAgentArchive({
                write: (_input, signal) => request(signal),
                reconcile: async () => {
                  callbacks++
                },
              })
              yield* send(archive.actor, {
                type: "REQUEST",
                agent: profile,
                archived: true,
              })
              yield* send(archive.actor, { type: "CONFIRM" })
              return archive
            }
            case "catalog":
              return yield* makeAgentCatalog(request)
            case "statuses":
              return yield* makeAgentStatuses({
                read: request,
                membership: () => "home:active",
                visible: () => true,
                listen: () => {
                  listeners++
                  return () => {
                    listeners--
                  }
                },
              })
          }
        }).pipe(Effect.provideService(Scope.Scope, scope))
        yield* Deferred.await(entered)
        owner.revoke()
        const closing = yield* Scope.close(scope, Exit.void).pipe(
          Effect.forkChild
        )
        yield* Deferred.await(aborted)
        yield* Effect.yieldNow
        expect(closing.pollUnsafe()).toBeUndefined()

        const annotations = Context.makeUnsafe(
          new Map([
            ["agents/native-cleanup", { owner: kind, phase: "after-abort" }],
          ])
        )
        const failure = Cause.makeFailReason({
          message: "late checked cleanup",
          owner: kind,
        }).annotate(annotations)
        const interrupted =
          Cause.makeInterruptReason(91073).annotate(annotations)
        reject(Cause.fromReasons([failure, interrupted]))
        const exit = yield* Fiber.await(closing)
        expect(callbacks).toBe(0)
        expect(listeners).toBe(0)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(
            exit.cause.reasons.some(
              (reason) =>
                reason === failure ||
                (reason._tag === "Die" && reason.defect === failure)
            )
          ).toBe(true)
          expect(exit.cause.reasons).toContain(interrupted)
          expect(
            exit.cause.reasons.some(
              (reason) => reason._tag === "Die" && Cause.isCause(reason.defect)
            )
          ).toBe(false)
        }
      }).pipe(Effect.scoped)
  )
