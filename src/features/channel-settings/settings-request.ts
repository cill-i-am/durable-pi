import { Cause, Effect, Exit, Schema } from "effect"

import { EmailView } from "@/email/contracts"
import { ApiError } from "@/http/client"
import { nativeOperation } from "@/shared/interop"
import { WhatsAppView } from "@/whatsapp/contracts"

import { SettingsChange, type Channel } from "./settings.machine"

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">
const saved = Schema.Struct({
  version: Schema.Literal(1),
  request: SettingsChange,
})
export const settingsRequestKey = (
  owner: string,
  agent: string,
  channel: Channel
) => `channel-settings:${JSON.stringify([owner, agent, channel])}`
export const definitiveSettingsFailure = (
  channel: Channel,
  cause: Cause.Cause<unknown>
) =>
  !Cause.hasDies(cause) &&
  !Cause.hasInterrupts(cause) &&
  cause.reasons.length > 0 &&
  cause.reasons.every(
    (reason) =>
      reason._tag === "Fail" &&
      reason.error instanceof ApiError &&
      (reason.error.status === 409 ||
        (channel === "whatsapp" && reason.error.status === 400))
  )
export function settingsRequests(
  channel: Channel,
  owner: string,
  agent: string,
  storage: Storage,
  api: (path: string, body?: unknown, signal?: AbortSignal) => Promise<unknown>,
  visible: () => boolean,
  targetApi?: (
    agentId: string,
    path: string,
    body: unknown,
    signal: AbortSignal
  ) => Promise<unknown>
) {
  const key = settingsRequestKey(owner, agent, channel)
  const decode = (value: unknown) =>
    channel === "email"
      ? Schema.decodeUnknownSync(EmailView)(value)
      : Schema.decodeUnknownSync(WhatsAppView)(value)
  const forget = (request: SettingsChange) =>
    Effect.try({
      try: () => {
        const current = storage.getItem(key)
        if (
          current &&
          Schema.decodeUnknownSync(saved)(JSON.parse(current)).request.body
            .operationId === request.body.operationId
        )
          storage.removeItem(key)
      },
      catch: (cause) => cause,
    })
  return {
    restore: Effect.try({
      try: () => {
        const current = storage.getItem(key)
        return current
          ? Schema.decodeUnknownSync(saved)(JSON.parse(current)).request
          : null
      },
      catch: () =>
        new Error(
          "The saved request could not be read. Keep this tab open and try reloading the settings."
        ),
    }),
    read: Effect.suspend(() =>
      visible()
        ? nativeOperation(
            (signal) => api(channel, undefined, signal),
            (cause) => cause
          ).pipe(Effect.map(decode))
        : Effect.succeed(null)
    ),
    definitive: (cause: Cause.Cause<unknown>) =>
      definitiveSettingsFailure(channel, cause),
    change: (request: SettingsChange) =>
      Effect.gen(function* () {
        const immutable = Schema.decodeUnknownSync(SettingsChange)(request)
        const target = immutable.agentId ?? agent
        if (target !== agent && !targetApi)
          return yield* Effect.fail(
            new Error(
              "The saved request belongs to another agent. No change was sent."
            )
          )
        yield* Effect.try({
          try: () =>
            storage.setItem(
              key,
              JSON.stringify({ version: 1, request: immutable })
            ),
          catch: () =>
            new Error(
              "The request could not be saved in this tab. No change was sent."
            ),
        })
        const response = yield* nativeOperation(
          (signal) =>
            target === agent
              ? api(`${channel}/${immutable.path}`, immutable.body, signal)
              : targetApi!(
                  target,
                  `${channel}/${immutable.path}`,
                  immutable.body,
                  signal
                ),
          (cause) => cause
        ).pipe(
          Effect.map(decode),
          Effect.catchCause((cause) =>
            definitiveSettingsFailure(channel, cause)
              ? forget(immutable).pipe(
                  Effect.exit,
                  Effect.flatMap((exit) =>
                    Effect.failCause(
                      Exit.isFailure(exit)
                        ? Cause.fromReasons([
                            ...cause.reasons,
                            ...exit.cause.reasons,
                          ])
                        : cause
                    )
                  )
                )
              : Effect.failCause(cause)
          )
        )
        yield* forget(immutable)
        return response
      }),
  }
}
