import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Cause, Deferred, Effect, Equal, Schema } from "effect"

import { agentApi } from "@/http/client"
import { orDieAll, preserveFatal } from "@/shared/effect"
import { nativeOperation } from "@/shared/interop"
import {
  Skill,
  SkillLibrary,
  SkillSelection,
  SkillVersions,
} from "@/skills/contracts"

import {
  skillsMachine,
  type SkillCommand,
  type SkillsWork,
} from "./skills.machine"

/** Retain fatal capability exits, preserving checked failures and annotations. */
export const skillWorkFailures = Effect.gen(function* () {
  const failures: Cause.Cause<unknown>[] = []
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      const reasons = failures
        .flatMap((failure) => failure.reasons)
        .filter(
          (reason, index, all) =>
            all.findIndex((other) => Equal.equals(other, reason)) === index
        )
      return reasons.length
        ? Effect.failCause(Cause.fromReasons(reasons)).pipe(orDieAll)
        : Effect.void
    })
  )
  return <A, E, R>(work: Effect.Effect<A, E, R>) =>
    work.pipe(
      preserveFatal,
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (exit._tag === "Failure" && Cause.hasDies(exit.cause))
            failures.push(exit.cause)
        })
      )
    )
})
export const skillRequest = (agentId: string, path: string, body?: unknown) =>
  nativeOperation(
    (signal) => agentApi(agentId)(path, body, signal),
    (cause) => cause
  )
export function skillsRequests(agentId: string | undefined): SkillsWork {
  return {
    read: () =>
      Effect.gen(function* () {
        const [library, selection] = yield* Effect.all(
          [
            skillRequest("home", "skills").pipe(
              Effect.map(Schema.decodeUnknownSync(SkillLibrary))
            ),
            agentId === undefined
              ? Effect.succeed({ revision: 0, skills: [] })
              : skillRequest(agentId, "skill-selection").pipe(
                  Effect.map(Schema.decodeUnknownSync(SkillSelection))
                ),
          ],
          { concurrency: 2 }
        )
        return { library: library.skills, selection }
      }),
    command: (command) => {
      if ((command.kind === "select") !== (agentId !== undefined))
        return Effect.fail(
          new Error("This change belongs to a different skills view.")
        )
      if (command.kind === "select")
        return skillRequest(agentId!, "skill-selection", command.input).pipe(
          Effect.map(
            Schema.decodeUnknownSync(
              SkillSelection.check(
                Schema.makeFilter(
                  (value) =>
                    JSON.stringify(
                      value.skills.map(({ id, revision }) => ({ id, revision }))
                    ) === JSON.stringify(command.input.skills) ||
                    "The response belongs to another selection."
                )
              )
            )
          )
        )
      return skillRequest("home", `skills/${command.kind}`, command.input).pipe(
        Effect.map(
          Schema.decodeUnknownSync(
            Skill.check(
              Schema.makeFilter(
                (value) =>
                  value.id === command.input.id ||
                  "The response belongs to another skill."
              )
            )
          )
        )
      )
    },
  }
}
export function makeSkillsOwner(agentId: string | undefined, work: SkillsWork) {
  return Effect.gen(function* () {
    const observe = yield* skillWorkFailures
    return yield* createEffectActor(
      skillsMachine({
        read: () => observe(work.read()),
        command: (input) => observe(work.command(input)),
      }),
      { input: agentId }
    )
  })
}
type Actor = EffectActor<ReturnType<typeof skillsMachine>>
export function skillCommand(actor: Actor, command: SkillCommand) {
  return Effect.gen(function* () {
    if (actor.getSnapshot().status !== "active") return undefined
    const id = crypto.randomUUID(),
      result = yield* Deferred.make<Skill | SkillSelection | undefined>()
    const settle = (value: Skill | SkillSelection | undefined) =>
      Effect.runSync(Deferred.succeed(result, value))
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        actor.on("settled", (event) => {
          if (event.id === id) settle(event.result)
        })
      ),
      (subscription) => Effect.sync(() => subscription.unsubscribe())
    )
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        actor.subscribe({
          complete: () => settle(undefined),
          error: () => settle(undefined),
        })
      ),
      (subscription) => Effect.sync(() => subscription.unsubscribe())
    )
    yield* send(actor, { type: "COMMAND", id, command })
    return yield* Deferred.await(result)
  }).pipe(Effect.scoped)
}

export const skillVersions = (id: string) =>
  skillRequest("home", `skills/${id}`).pipe(
    Effect.map(
      Schema.decodeUnknownSync(
        SkillVersions.check(
          Schema.makeFilter(
            (value) =>
              value.versions.every((version) => version.id === id) ||
              "The history belongs to another skill."
          )
        )
      )
    ),
    Effect.map((value) => value.versions)
  )
