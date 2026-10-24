import { createEffectActor } from "@xstate/effect"
import { Effect, Redacted } from "effect"

import {
  familyJoinMachine,
  joinAllowed,
  type JoinSource,
  type JoinInvitation,
  type JoinCommand,
  type JoinSession,
  type JoinResult,
} from "./family-join.machine"
import { makeFamilyRequests } from "./family-requests"

export function makeFamilyJoin(ports: {
  verify: (token: string, signal: AbortSignal) => Promise<void>
  locate: (signal: AbortSignal) => Promise<string>
  preview: (id: string, signal: AbortSignal) => Promise<JoinInvitation>
  refresh: () => Promise<unknown>
  session: () => JoinSession | null
  change: (
    invitation: JoinInvitation,
    command: JoinCommand,
    signal: AbortSignal
  ) => Promise<void>
  joined: (id: string) => void
  classify: (cause: unknown) => { unavailable: boolean; temporary: boolean }
}) {
  return Effect.gen(function* () {
    const requests = yield* makeFamilyRequests()
    let generation = 0
    let active: AbortController | undefined
    const current = (source: JoinSource) =>
      requests.active() && source.generation === generation
    const request = <T>(
      source: JoinSource,
      work: (signal: AbortSignal) => Promise<T>
    ) =>
      requests.request(async (signal) => {
        if (!current(source)) throw new Error("Invitation changed.")
        const controller = new AbortController()
        active = controller
        try {
          return await work(AbortSignal.any([signal, controller.signal]))
        } finally {
          if (active === controller) active = undefined
        }
      })
    const result = <T>(
      work: Effect.Effect<T, unknown>
    ): Effect.Effect<JoinResult<T>> =>
      work.pipe(
        Effect.match({
          onSuccess: (value) => ({ ok: true as const, value }),
          onFailure: (cause) => {
            const kind = ports.classify(cause)
            return {
              ok: false as const,
              ...kind,
              error: kind.unavailable
                ? "This invitation is no longer available. Open the latest invitation email, or ask your family admin to resend it."
                : cause instanceof Error
                  ? cause.message
                  : "Could not connect. Please try again.",
            }
          },
        })
      )
    const actor = yield* createEffectActor(
      familyJoinMachine({
        verify: (source) =>
          result(
            request(source, (signal) =>
              ports.verify(Redacted.value(source.token!), signal)
            )
          ),
        locate: (source) =>
          result(
            source.id
              ? Effect.succeed(source.id)
              : request(source, ports.locate)
          ),
        preview: (source) =>
          result(
            request(source, (signal) => ports.preview(source.id!, signal))
          ),
        refresh: (source) =>
          current(source)
            ? request(source, ports.refresh).pipe(
                Effect.asVoid,
                Effect.catch(() => Effect.void)
              )
            : Effect.void,
        change: (source, invitation, command) =>
          result(
            request(source, async (signal) => {
              if (!joinAllowed(command.kind, invitation, ports.session()))
                throw new Error(
                  "Your account has changed. Check this invitation before continuing."
                )
              await ports.change(invitation, command, signal)
              if (
                !current(source) ||
                (command.kind === "accept" &&
                  !joinAllowed("accept", invitation, ports.session()))
              )
                throw new Error(
                  "Your account or invitation has changed. Check the current invitation before continuing."
                )
            })
          ),
        joined: (source, invitation) =>
          Effect.sync(() => {
            if (
              !current(source) ||
              !joinAllowed("accept", invitation, ports.session())
            )
              return false
            ports.joined(source.id!)
            return true
          }),
      })
    )
    return {
      actor,
      revoke: () => {
        requests.revoke()
        active?.abort()
      },
      open: (id: string | null, token: string | null) => {
        generation++
        active?.abort()
        actor.send({
          type: "OPEN",
          source: {
            generation,
            id,
            token: token ? Redacted.make(token) : null,
          },
        })
      },
      refresh: async (expected: number) => {
        if (expected === generation && requests.active())
          actor.send({ type: "SIGNED_IN", generation: expected })
      },
    }
  })
}
