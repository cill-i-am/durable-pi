import { createEffectActor } from "@xstate/effect"
import { Clock, Effect, Redacted, Schema } from "effect"

import { makeFamilyRequests } from "./family-requests"
import {
  ModelSignInPending,
  modelSignInMachine,
  type SignInResult,
} from "./model-sign-in.machine"

type Popup = {
  location: { replace: (url: string) => void }
  close: () => void
  opener: unknown
}
export function makeModelSignIn(ports: {
  account: <T>(body: unknown | undefined, signal: AbortSignal) => Promise<T>
  connected: () => Promise<void>
  authorized: () => boolean
  popup: () => Popup | null
}) {
  return Effect.gen(function* () {
    const requests = yield* makeFamilyRequests()
    let popup: { tab: Popup | null } | undefined
    const closePopup = () => {
      popup?.tab?.close()
      popup = undefined
    }
    const revoke = () => {
      requests.revoke()
      closePopup()
    }
    yield* Effect.addFinalizer(() => Effect.sync(closePopup))
    const call = <T>(body: unknown | undefined) =>
      requests.request<T>(async (signal) => {
        if (!ports.authorized())
          throw new Error("Only the current family admin can connect ChatGPT.")
        const value = await ports.account<T>(body, signal)
        if (!requests.active() || !ports.authorized())
          throw new Error(
            "Your family access has changed. Refresh before continuing."
          )
        return value
      })
    const result = <T>(
      work: Effect.Effect<T, unknown>
    ): Effect.Effect<SignInResult<T>> =>
      work.pipe(
        Effect.match({
          onSuccess: (value) => ({ ok: true as const, value }),
          onFailure: (cause) => ({
            ok: false as const,
            error:
              cause instanceof Error
                ? cause.message
                : "Could not connect. Please try again.",
          }),
        }),
        Effect.flatMap((value) =>
          Clock.currentTimeMillis.pipe(Effect.map((now) => ({ ...value, now })))
        )
      )
    const restore = result(
      call<{ pending: unknown }>(undefined).pipe(
        Effect.flatMap((value) =>
          Effect.try(() =>
            value.pending === null
              ? null
              : Schema.decodeUnknownSync(ModelSignInPending)(value.pending)
          )
        )
      )
    )
    const actor = yield* createEffectActor(
      modelSignInMachine({
        restore,
        start: (email) =>
          result(
            call<unknown>({ action: "start", email }).pipe(
              Effect.flatMap((value) =>
                Effect.try(() =>
                  Schema.decodeUnknownSync(ModelSignInPending)(value)
                )
              ),
              Effect.tap((attempt) =>
                Effect.sync(() => {
                  if (!requests.active() || !ports.authorized()) return
                  popup?.tab?.location.replace(attempt.authorizationUrl)
                  popup = undefined
                })
              ),
              Effect.ensuring(Effect.sync(closePopup))
            )
          ),
        finish: (id, address) =>
          result(
            call<unknown>({
              action: "finish",
              id,
              address: Redacted.value(address),
            }).pipe(
              Effect.flatMap((value) =>
                Effect.try(
                  () =>
                    Schema.decodeUnknownSync(
                      Schema.Struct({
                        status: Schema.Literal("connected"),
                        email: Schema.String,
                      })
                    )(value).email
                )
              )
            )
          ),
        cancel: result(call<void>({ action: "cancel" })),
        connected: Effect.suspend(() =>
          requests.active() && ports.authorized()
            ? requests
                .request(() => ports.connected())
                .pipe(Effect.catch(() => Effect.void))
            : Effect.void
        ),
      })
    )
    return {
      actor,
      revoke,
      start: (email: string) => {
        const state = actor.getSnapshot()
        if (
          !requests.active() ||
          !ports.authorized() ||
          popup ||
          (!state.matches("idle") && !state.matches("cancelled"))
        )
          return
        popup = { tab: ports.popup() }
        if (popup.tab) popup.tab.opener = null
        actor.send({ type: "START", email })
      },
    }
  })
}
