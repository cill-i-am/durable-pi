import { ApiError } from "@/http/client"
import type { Profile, JobType } from "@/inference/policy"
import type {
  ModelSelection,
  Submission,
  SubmissionMode,
} from "@/conversations/turns"

/** Retries keep the admitted intent even when live updates change the composer mode. */
export function submissionAttempt(
  previous: Submission | null,
  text: string,
  mode: SubmissionMode,
  files: readonly string[] = [],
  profile: Profile = "auto",
  job: JobType = "conversation"
): Submission {
  return previous?.text === text &&
    JSON.stringify(previous.files ?? []) === JSON.stringify(files)
    ? previous
    : {
        operationId: crypto.randomUUID(),
        text,
        mode,
        profile: mode === "steer" ? "auto" : profile,
        job,
        ...(files.length ? { files } : {}),
      }
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

export function rejectedModelAttempt(error: unknown) {
  return error instanceof ApiError && error.code === "model_unavailable"
}
