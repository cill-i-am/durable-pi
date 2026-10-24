import { Cause, Effect, Exit, Fiber, Schema } from "effect"
import { useEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import {
  AgentId,
  AgentProfileResponse,
  type AgentProfile,
} from "@/agents/contracts"
import { api } from "@/http/client"

import { makeAgentEditor } from "./agent-editor-owner"
import type { agentEditorMachine } from "./agent-editor.machine"

export function useAgentEditor(
  agent: AgentProfile | undefined,
  onSaved: (profile: AgentProfile, signal?: AbortSignal) => Promise<void>,
  close: () => void
) {
  const [id] = useState(
    () => agent?.id ?? Schema.decodeUnknownSync(AgentId)(crypto.randomUUID())
  )
  const ports = useRef({ onSaved, close })
  ports.current = { onSaved, close }
  const owner = useRef<Effect.Success<
    ReturnType<typeof makeAgentEditor>
  > | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<
    ReturnType<typeof agentEditorMachine>
  > | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const current = yield* makeAgentEditor(
          { id, agent: agent ?? null },
          {
            save: async ({ id, name, instructions, action }, signal) =>
              Schema.decodeUnknownSync(AgentProfileResponse)(
                await api(
                  `/api/agent/bots/${action}`,
                  { id, name, instructions },
                  signal
                )
              ),
            reconcile: (profile, signal) =>
              ports.current.onSaved(profile, signal),
            close: () => ports.current.close(),
          }
        )
        owner.current = current
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            current.actor.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) setSnapshot(current.actor.getSnapshot())
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      owner.current?.revoke()
      owner.current = null
      Effect.runFork(
        Fiber.interrupt(fiber).pipe(
          Effect.andThen(Fiber.await(fiber)),
          Effect.flatMap((exit) =>
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? Effect.logError(exit.cause)
              : Effect.void
          )
        )
      )
    }
    // The keyed editor captures its initial profile; catalog refresh cannot reset edits.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [id])
  return {
    id,
    ready: snapshot !== null,
    draft: snapshot?.context.draft ?? {
      name: agent?.name ?? "",
      instructions: agent?.instructions ?? "",
    },
    error: snapshot?.context.error ?? "",
    pending:
      !snapshot ||
      snapshot.matches("saving") ||
      snapshot.matches("reconciling") ||
      snapshot.matches("closing"),
    existing: snapshot?.context.existing ?? !!agent,
    refreshFailed: snapshot?.matches("refreshFailed") ?? false,
    change: (field: "name" | "instructions", value: string) =>
      owner.current?.actor.send({ type: "CHANGE", field, value }),
    save: () => owner.current?.actor.send({ type: "SAVE" }),
    reconcile: () => owner.current?.actor.send({ type: "RECONCILE" }),
    dismiss: () => owner.current?.actor.send({ type: "DISMISS" }),
  }
}
