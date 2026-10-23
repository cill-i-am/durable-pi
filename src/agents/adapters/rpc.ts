import { Cause, Effect, Schema } from "effect"

import { RuntimeStatus } from "../../conversations/status"
import { nativeFailure, nativeOperation } from "../../shared/interop"
import { rpcOutcome } from "../../shared/rpc-outcome"
import { AgentProfileResponse } from "../contracts"
import {
  AgentId,
  AgentProfile,
  AgentNotFound,
  AgentConflict,
  AgentStorageError,
  AgentSynchronizationError,
  AgentRuntimeUnavailable,
} from "../domain"

export const AgentProfiles = Schema.Array(AgentProfileResponse)
export const AgentContacts = Schema.Array(
  Schema.Struct({ id: AgentProfile.fields.id, name: AgentProfile.fields.name })
)
const Profile = Schema.NullOr(AgentProfileResponse)
const Ack = Schema.Literal(true)
export const AgentRequest = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Profiles") }),
  Schema.Struct({ _tag: Schema.Literal("Contacts") }),
  Schema.Struct({ _tag: Schema.Literal("Profile"), id: AgentId }),
  Schema.Struct({ _tag: Schema.Literal("Status") }),
  Schema.Struct({
    _tag: Schema.Literal("Configure"),
    owner: Schema.String,
    profile: AgentProfileResponse,
    communicationOwner: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.Literal("PrepareCommunication"),
    owner: Schema.String,
    id: AgentId,
  }),
])
export const AgentResult = Schema.Union([
  AgentProfiles,
  AgentContacts,
  Profile,
  RuntimeStatus,
  Ack,
])
export const AgentFailure = Schema.Union([
  AgentNotFound,
  AgentConflict,
  AgentStorageError,
  AgentSynchronizationError,
  AgentRuntimeUnavailable,
])
export const AgentOutcome = rpcOutcome(
  AgentResult,
  AgentFailure,
  "Agent operation failed unexpectedly."
)
export interface AgentRpc {
  agentV1?: (input: typeof AgentRequest.Type) => Promise<unknown>
  agentProfiles?: () => Promise<unknown>
  activityAgents?: () => Promise<unknown>
  agentProfile?: (id: string) => Promise<unknown>
  runtimeStatus?: () => Promise<unknown>
  configureBot?: (
    owner: string,
    profile: AgentProfile,
    communicationOwner?: string
  ) => Promise<unknown>
  prepareCommunication?: (owner: string, id: AgentId) => Promise<unknown>
}
export function agentRpc(stub: AgentRpc) {
  /** Legacy fallbacks cover reads and idempotent profile projection only. Decode
   * modern replies after this catch so a remote defect never triggers fallback. */
  const invoke = <T>(
    request: typeof AgentRequest.Type,
    schema: Schema.Codec<T, unknown>,
    legacy?: () => Promise<unknown>
  ) => {
    const previous = () => {
      if (!legacy) throw Cause.die("Agent protocol is unavailable.")
      return legacy().then((raw) => {
        try {
          return Schema.decodeUnknownSync(schema)(raw)
        } catch (cause) {
          throw Cause.die(cause)
        }
      })
    }
    if (!stub.agentV1) return previous()
    return stub.agentV1(request).then(
      (raw) => AgentOutcome.unwrap(raw, schema),
      (cause: unknown) => {
        if (Cause.isCause(cause) || Schema.isSchemaError(cause) || !legacy)
          throw cause
        return previous()
      }
    )
  }
  const unavailable = () =>
    Promise.reject(
      new AgentSynchronizationError({ operation: "call previous agent" })
    )
  return {
    contacts: () =>
      invoke(
        { _tag: "Contacts" },
        AgentContacts,
        () => stub.activityAgents?.() ?? unavailable()
      ).then((values) => [...values]),
    profiles: () =>
      invoke(
        { _tag: "Profiles" },
        AgentProfiles,
        () => stub.agentProfiles?.() ?? unavailable()
      ).then((values) => [...values]),
    profile: (id: AgentId) =>
      invoke(
        { _tag: "Profile", id },
        Profile,
        () => stub.agentProfile?.(id) ?? unavailable()
      ).then((value) => {
        if (value && value.id !== id)
          throw Cause.die("Profile belongs to a different bot.")
        return value
      }),
    status: () =>
      invoke(
        { _tag: "Status" },
        RuntimeStatus,
        () => stub.runtimeStatus?.() ?? unavailable()
      ),
    configure: (
      owner: string,
      value: AgentProfile,
      communicationOwner?: string
    ) =>
      invoke(
        { _tag: "Configure", owner, profile: value, communicationOwner },
        Ack,
        () =>
          (
            stub.configureBot?.(owner, value, communicationOwner) ??
            unavailable()
          ).then(() => true)
      ),
    prepare: (owner: string, id: AgentId) =>
      invoke({ _tag: "PrepareCommunication", owner, id }, Ack, () =>
        (stub.prepareCommunication?.(owner, id) ?? unavailable()).then(
          () => true
        )
      ),
  }
}
const agentRpcFailure = (cause: unknown, channel: "failure" | "rejection") => {
  const known = Schema.decodeUnknownOption(AgentFailure)(cause)
  if (known._tag === "Some") return known.value
  if (channel === "failure" || Schema.isSchemaError(cause)) throw cause
  return new AgentSynchronizationError({ operation: "call agent owner" })
}
export const agentRpcNative = <T>(start: () => Promise<T>) =>
  nativeOperation(start, agentRpcFailure)

/** Bounded observation of independently owned remote profile/configuration
 * work. Local transactions and resource cleanup retain the joined bridge. */
export const observeAgentRpc = <T>(start: () => Promise<T>) =>
  Effect.suspend(() => {
    const pending = start()
    return Effect.tryPromise({
      try: () => pending,
      catch: (cause) => nativeFailure(cause, agentRpcFailure),
    }).pipe(Effect.catch((cause) => Effect.failCause(cause)))
  })
