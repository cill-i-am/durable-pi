import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useMemo, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { agentApi } from "@/http/client"

import {
  makeMemoryImport,
  readMemoryImport,
  submitMemoryImport,
} from "./import-owner"
import type { memoryImportMachine } from "./import.machine"

type Machine = ReturnType<typeof memoryImportMachine>
export function MemoryImport({
  agentId,
  refresh,
}: {
  agentId: string
  refresh: () => void
}) {
  const api = useMemo(() => agentApi(agentId), [agentId])
  const [actor, setActor] = useState<EffectActor<Machine> | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<Machine> | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owned = yield* makeMemoryImport({
          read: readMemoryImport,
          submit: (jsonl) =>
            submitMemoryImport(
              (body, signal) => api("import", { jsonl: body }, signal),
              jsonl
            ).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (mounted) refresh()
                })
              )
            ),
        })
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owned.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) {
          setActor(owned)
          setSnapshot(owned.getSnapshot())
        }
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
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
  }, [api, refresh])
  const pending =
    !snapshot || snapshot.matches("reading") || snapshot.matches("submitting")
  const outcome = snapshot?.context.outcome
  const failed =
    outcome && Exit.isFailure(outcome)
      ? outcome.cause.reasons.find((reason) => reason._tag === "Fail")
      : undefined
  const status =
    outcome && Exit.isSuccess(outcome)
      ? `${outcome.value.added} messages imported. Their summaries will build in the background.`
      : outcome
        ? failed?._tag === "Fail" && failed.error instanceof Error
          ? failed.error.message
          : "Could not confirm the import. Retry the same file."
        : ""
  const retry = snapshot?.matches("unconfirmed") === true
  return (
    <article>
      <h3>Import older history</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (actor)
            Effect.runFork(send(actor, { type: retry ? "RETRY" : "SUBMIT" }))
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="history-file">Messages file</FieldLabel>
            <Input
              id="history-file"
              type="file"
              accept=".jsonl,.ndjson"
              disabled={pending}
              onChange={(event) => {
                if (actor)
                  Effect.runFork(
                    send(actor, {
                      type: "SELECT",
                      file: event.target.files?.[0] ?? null,
                      id: crypto.randomUUID(),
                    })
                  )
              }}
            />
            <FieldDescription>
              One JSON object per line with kind, text, and an ISO date. Up to
              200 messages and 1 MB per file. Imported text becomes history; it
              does not start a reply.
            </FieldDescription>
          </Field>
          <Button
            type="submit"
            variant="outline"
            disabled={
              !snapshot?.context.file || pending || snapshot.matches("done")
            }
          >
            {pending
              ? "Importing…"
              : retry
                ? "Retry same import"
                : "Import history"}
          </Button>
        </FieldGroup>
      </form>
      {status && (
        <Alert>
          <AlertDescription>{status}</AlertDescription>
        </Alert>
      )}
    </article>
  )
}
