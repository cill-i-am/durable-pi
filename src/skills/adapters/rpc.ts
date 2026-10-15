import { Cause, Exit, Schema } from "effect"
import {
  SkillConflict,
  SkillStorageError,
  SkillDocument,
  SelectSkills,
} from "../contracts"
import { rpcOutcome } from "../../shared/rpc-outcome"
import { nativeOperation } from "../../shared/interop"

export const SkillReferences = SelectSkills.fields.skills
export const ResolvedSkills = Schema.Array(SkillDocument)
const SkillFailure = Schema.Union([SkillConflict, SkillStorageError])
const outcome = rpcOutcome(
  ResolvedSkills,
  SkillFailure,
  "Skill resolution failed unexpectedly."
)
export const SkillOutcome = {
  ...outcome,
  encode: (exit: Exit.Exit<typeof ResolvedSkills.Type, unknown>): Schema.Json =>
    outcome.encode(
      Exit.isSuccess(exit)
        ? exit
        : Exit.failCause(
            Cause.map(exit.cause, (cause) => {
              const known = Schema.decodeUnknownOption(SkillFailure)(cause)
              return known._tag === "Some" &&
                known.value._tag === "SkillStorageError"
                ? new SkillStorageError({
                    operation: known.value.operation,
                    cause: "Remote skill storage failed.",
                  })
                : cause
            })
          )
    ),
}
export function skillRpc(stub: {
  skillVersionsV1: (input: typeof SkillReferences.Type) => Promise<unknown>
}) {
  return {
    resolve: (references: typeof SkillReferences.Type) =>
      stub
        .skillVersionsV1(references)
        .then((raw) => [...SkillOutcome.unwrap(raw, ResolvedSkills)]),
  }
}
export const skillNative = <T>(start: () => Promise<T>) =>
  nativeOperation(start, (cause, channel) => {
    const known = Schema.decodeUnknownOption(SkillFailure)(cause)
    if (known._tag === "Some") return known.value
    if (channel === "failure" || Schema.isSchemaError(cause)) throw cause
    return new SkillStorageError({ operation: "resolve owner skills", cause })
  })
