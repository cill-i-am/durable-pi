import type {
  ModelSelection,
  Submission,
  SubmissionMode,
} from "@/conversations/turns"

/** Retries keep the admitted intent even when live updates change the composer mode. */
export function submissionAttempt(
  previous: Submission | null,
  text: string,
  mode: SubmissionMode
): Submission {
  return previous?.text === text
    ? previous
    : { operationId: crypto.randomUUID(), text, mode }
}

/** A confirmed command response stays authoritative until the stream catches up. */
export function newestSelection(
  stream: ModelSelection,
  confirmed: ModelSelection | null
): ModelSelection {
  return confirmed && confirmed.settingsRevision > stream.settingsRevision
    ? confirmed
    : stream
}
