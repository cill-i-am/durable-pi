import { send } from "@xstate/effect"
import { Effect, Fiber } from "effect"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import type { Submission } from "@/conversations/turns"
import type { FilesState } from "@/features/files"
import { agentApi } from "@/http/client"
import { nativeOperation } from "@/shared/interop"

import { makeSubmission } from "./submission-owner"
import { submissionMachine, type SubmissionRequest } from "./submission.machine"
import { makeTurnCommand } from "./turn-command-owner"
import { turnCommandMachine } from "./turn-command.machine"
import type { ComposerDraftState } from "./use-composer-draft"

type SubmissionOwner = Effect.Success<ReturnType<typeof makeSubmission>>
type TurnOwner = Effect.Success<ReturnType<typeof makeTurnCommand>>
type SubmissionSnapshot = SnapshotFrom<ReturnType<typeof submissionMachine>>
type TurnSnapshot = SnapshotFrom<ReturnType<typeof turnCommandMachine>>

export function useConversationCommands(
  agentId: string,
  draft: ComposerDraftState,
  files: FilesState,
  submit: (input: Submission, signal?: AbortSignal) => Promise<void>,
  setSending: (value: boolean) => void
) {
  const api = useMemo(() => agentApi(agentId), [agentId])
  const ports = useRef({ draft, files, submit, setSending })
  ports.current = { draft, files, submit, setSending }
  const initial = useRef(draft.value.attempt)
  const owner = useRef<{ submission: SubmissionOwner; turn: TurnOwner } | null>(
    null
  )
  const [snapshot, setSnapshot] = useState<{
    submission: SubmissionSnapshot
    turn: TurnSnapshot
  } | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const submission = yield* makeSubmission(initial.current, {
          persist: (attempt) =>
            nativeOperation(
              () => ports.current.draft.update({ attempt }),
              (cause) => cause
            ),
          send: (attempt) =>
            nativeOperation(
              (signal) => ports.current.submit(attempt, signal),
              (cause) => cause
            ),
          acknowledge: (attempt) =>
            nativeOperation(
              async () => {
                const submitted = attempt.files ?? []
                ports.current.files.clear(submitted)
                await ports.current.draft.update((current) =>
                  current.attempt?.operationId === attempt.operationId
                    ? {
                        attempt: null,
                        // Preserve model selections made while this request was pending.
                        profile:
                          current.profile === attempt.profile
                            ? "auto"
                            : current.profile,
                        job:
                          current.job === attempt.job
                            ? "conversation"
                            : current.job,
                        files: current.files.filter(
                          (file) => !submitted.includes(file.id)
                        ),
                      }
                    : {}
                )
              },
              (cause) => cause
            ),
          rejectModel: (attempt) =>
            nativeOperation(
              async () => {
                await ports.current.draft.update((current) =>
                  current.attempt?.operationId === attempt.operationId
                    ? { attempt: null }
                    : {}
                )
              },
              (cause) => cause
            ),
        })
        const turn = yield* makeTurnCommand((input) =>
          nativeOperation(
            (signal) =>
              input.action === "retry"
                ? api(
                    "retry",
                    { turnId: input.turnId, operationId: input.operationId },
                    signal
                  )
                : api("cancel", { operationId: input.operationId }, signal),
            (cause) => cause
          ).pipe(Effect.asVoid)
        )
        const update = () => {
          if (!mounted) return
          const current = {
            submission: submission.actor.getSnapshot(),
            turn: turn.getSnapshot(),
          }
          setSnapshot(current)
          ports.current.setSending(!current.submission.matches("ready"))
        }
        owner.current = { submission, turn }
        yield* Effect.acquireRelease(
          Effect.sync(() => [
            submission.actor.subscribe(update),
            turn.subscribe(update),
          ]),
          (subscriptions) =>
            Effect.sync(() =>
              subscriptions.forEach((subscription) =>
                subscription.unsubscribe()
              )
            )
        )
        update()
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      owner.current = null
      Effect.runFork(
        Fiber.interrupt(fiber).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              console.error("Conversation command cleanup failed", cause)
            })
          )
        )
      )
    }
  }, [agentId, api])
  const sendSubmission = useCallback((input: SubmissionRequest) => {
    const current = owner.current
    return current
      ? Effect.runPromise(
          Effect.andThen(
            send(current.turn, { type: "CLEAR_ERROR" }),
            current.submission.submit(input)
          )
        )
      : Promise.resolve(false)
  }, [])
  const retry = useCallback((turnId: string, allowed: boolean) => {
    const current = owner.current
    if (current)
      Effect.runFork(
        Effect.andThen(
          send(current.submission.actor, { type: "CLEAR_ERROR" }),
          send(current.turn, { type: "RETRY", turnId, allowed })
        )
      )
  }, [])
  const cancel = useCallback((turnId: string) => {
    const current = owner.current
    if (current)
      Effect.runFork(
        Effect.andThen(
          send(current.submission.actor, { type: "CLEAR_ERROR" }),
          send(current.turn, { type: "CANCEL", turnId })
        )
      )
  }, [])
  return {
    ready: snapshot !== null,
    send: sendSubmission,
    retry,
    cancel,
    pending: snapshot ? snapshot.submission.context.pending : initial.current,
    retrying:
      snapshot?.turn.matches("requesting") &&
      snapshot.turn.context.request?.action === "retry"
        ? snapshot.turn.context.request.turnId
        : null,
    error:
      snapshot?.submission.context.error || snapshot?.turn.context.error || "",
  }
}
