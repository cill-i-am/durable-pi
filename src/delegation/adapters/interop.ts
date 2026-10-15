import { Option, Schema, type Effect } from "effect"
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context"
import type { Context } from "@earendil-works/chord"
import type { Harness, Tx } from "@earendil-works/pi-durable"
import { DelegationFailure } from "../contracts"
import { nativeOperation } from "../../shared/interop"
import { nativeCommit } from "../../shared/adapters/native-commit"

const decodeBackgroundFailure = Schema.decodeUnknownOption(DelegationFailure)

/** Pi may reject with a complete local Cause. Preserve its failure meanings and
 * retain late defects while joining settlement after caller interruption. Native
 * DO RPC serialization remains a separate transport boundary. */
export const backgroundNative = <T>(
  body: (signal: AbortSignal) => Promise<T>
) =>
  nativeOperation(body, (cause, channel) => {
    const error = Option.getOrUndefined(decodeBackgroundFailure(cause))
    if (error) return error
    if (channel === "failure") throw cause
    return new DelegationFailure({
      code: "unavailable",
      message:
        "Background task state could not be confirmed. Retry the same operation.",
    })
  })

const unavailable = () =>
  new DelegationFailure({
    code: "unavailable",
    message: "The task state could not be confirmed. Retry the same operation.",
  })
const delegationRejected = (
  cause: unknown,
  channel: "failure" | "rejection"
) => {
  const error = Option.getOrUndefined(decodeBackgroundFailure(cause))
  if (error) return error
  if (
    channel === "failure" ||
    Schema.isSchemaError(cause) ||
    cause instanceof SyntaxError
  )
    throw cause
  return unavailable()
}
export const delegationNative = <T>(start: (context: Context) => Promise<T>) =>
  nativeOperation(
    (signal) => start(withAbortSignal(signal, BACKGROUND_CONTEXT)),
    delegationRejected
  )

/** One genuine async Pi commit callback. Every Effect uses its native Tx and
 * the caller's Context. A failed callback aborts the native commit; native
 * rollback/settlement is joined even after caller interruption. */
export function delegationCommit<T, TError, TRequirements>(
  harness: Harness,
  body: (tx: Tx) => Effect.Effect<T, TError, TRequirements>
): Effect.Effect<T, TError | DelegationFailure, TRequirements> {
  return nativeCommit<Tx, T, TError, TRequirements, DelegationFailure>(
    (change, signal) =>
      harness.commit(change, withAbortSignal(signal, BACKGROUND_CONTEXT)),
    body,
    delegationRejected
  )
}
