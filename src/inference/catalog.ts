import { createEffectActor, send } from "@xstate/effect"
import {
  Cache,
  Deferred,
  Clock,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Scope,
} from "effect"

import { orDieAll, preserveFatal } from "../shared/effect"
import {
  catalogMachine,
  catalogUnavailable,
  type CatalogReply,
  type CatalogAnswer,
  type CatalogSnapshot,
} from "./catalog.machine"
import { ModelUnavailable, ModelCatalog } from "./policy"
export { CatalogSnapshot } from "./catalog.machine"

export interface CatalogGrant {
  /** Connection generation plus adapter capabilities; null forwards to the owner. */
  identity: string | null
  load: () => Effect.Effect<ModelCatalog, ModelUnavailable>
}
export interface CatalogSource {
  current: () => Effect.Effect<CatalogGrant, ModelUnavailable>
}
export interface CatalogStorage {
  read: () => Effect.Effect<CatalogSnapshot | undefined, ModelUnavailable>
  write: (value: CatalogSnapshot) => Effect.Effect<void, ModelUnavailable>
}
export interface CatalogOptions {
  storage?: CatalogStorage
  retain?: (work: Effect.Effect<void>) => void
}
export class ModelCatalogReader extends Context.Service<
  ModelCatalogReader,
  { read: () => Effect.Effect<ModelCatalog> }
>()("durable-pi/inference/ModelCatalogReader") {}

const changed = () =>
  new ModelUnavailable({
    message:
      "The ChatGPT connection changed. Reload to verify model availability.",
  })

export const makeModelCatalog = (
  source: CatalogSource,
  options: CatalogOptions = {}
) =>
  Effect.gen(function* () {
    const background = yield* Scope.make()
    const actor = yield* createEffectActor(catalogMachine)
    const ask = (
      event: (reply: CatalogReply) => Parameters<typeof actor.send>[0]
    ) =>
      Effect.gen(function* () {
        if (actor.getSnapshot().status !== "active")
          return yield* Effect.interrupt
        const reply = yield* Deferred.make<CatalogAnswer>()
        yield* send(actor, event(reply))
        return yield* Deferred.await(reply)
      })
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* ask((reply) => ({ type: "CLOSE", reply }))
        // Keep the actor alive until every native background lookup has joined.
        // Its SETTLED event preserves cleanup even when Cache materializes Exit.
        yield* Scope.close(background, Exit.void)
        const cleanup = actor.getSnapshot().context.cleanup
        if (cleanup) return yield* Effect.failCause(cleanup).pipe(orDieAll)
      })
    )
    const publish = (value: CatalogSnapshot) =>
      Effect.gen(function* () {
        if (options.storage)
          yield* options.storage
            .write(value)
            .pipe(
              Effect.tapCause((cause) =>
                ask((reply) => ({ type: "FAILED", cause, reply }))
              )
            )
        yield* ask((reply) => ({ type: "COMMIT", saved: value, reply }))
      })
    // Cache owns concurrent acquisition; only the persisted snapshot has a TTL.
    const pending = yield* Cache.makeWith(
      (identity: string) =>
        Effect.gen(function* () {
          const grant = yield* source.current()
          if (grant.identity !== identity) return yield* changed()
          const result = yield* grant.load().pipe(preserveFatal, Effect.result)
          if ((yield* source.current()).identity !== identity)
            return yield* changed()
          const now = yield* Clock.currentTimeMillis
          const candidate = yield* ask((reply) => ({
            type: "OUTCOME",
            identity,
            now,
            reply,
            outcome:
              result._tag === "Success"
                ? { kind: "success", value: result.success }
                : { kind: "rejection", error: result.failure },
          }))
          if (candidate.kind !== "candidate") return yield* Effect.interrupt
          yield* publish(candidate.value)
          if (candidate.error) return yield* candidate.error
          return candidate.value.value
        }).pipe(
          // Observe the lookup itself: Cache interrupts and joins its native
          // child, but its waiting caller may only see the interruption.
          Effect.onExit((exit) =>
            ask((reply) => ({
              type: "SETTLED",
              identity,
              reply,
              cause: Exit.isFailure(exit) ? exit.cause : undefined,
            }))
          )
        ),
      { capacity: 4, requireServicesAt: "lookup", timeToLive: () => 0 }
    )
    const refresh = (identity: string) => Cache.get(pending, identity)
    const read = Effect.fn("Inference.readModelCatalog")(() =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const grant = yield* restore(source.current())
          const now = yield* Clock.currentTimeMillis
          let decision = yield* ask((reply) => ({
            type: "READ",
            identity: grant.identity,
            now,
            reply,
          }))
          if (decision.kind === "restore") {
            const saved = options.storage
              ? yield* restore(options.storage.read())
              : undefined
            yield* ask((reply) => ({ type: "RESTORE", saved, reply }))
            const now = yield* Clock.currentTimeMillis
            decision = yield* ask((reply) => ({
              type: "READ",
              identity: grant.identity,
              now,
              reply,
            }))
          }
          switch (decision.kind) {
            case "failed":
              return yield* Effect.failCause(decision.cause)
            case "forward":
              return yield* restore(grant.load())
            case "refresh":
              return yield* restore(refresh(decision.identity))
            case "value": {
              if (decision.background) {
                const identity = decision.background
                const fiber = yield* Effect.forkIn(
                  refresh(identity).pipe(Effect.interruptible, Effect.exit),
                  background
                )
                options.retain?.(Fiber.await(fiber).pipe(Effect.asVoid))
              }
              return decision.value
            }
            default:
              return yield* Effect.die(
                new Error("Invalid catalog read decision")
              )
          }
        })
      ).pipe(
        preserveFatal,
        Effect.catchTag("ModelUnavailable", (error) =>
          Effect.succeed(catalogUnavailable(error.message))
        )
      )
    )
    return { read }
  })
export const catalogApplication = (
  source: CatalogSource,
  options: CatalogOptions = {}
) => Layer.effect(ModelCatalogReader, makeModelCatalog(source, options))
