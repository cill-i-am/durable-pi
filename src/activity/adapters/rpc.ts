import { Cause, Schema, type Effect } from "effect"
import { RunCursor } from "../run"
import { rpcOutcome } from "../../shared/rpc-outcome"
import {
  AgentFailure,
  agentRpc,
  type AgentRpc,
} from "../../agents/adapters/rpc"
import {
  AccountFailure,
  accountConnectionRpc,
} from "../../inference/adapters/account-rpc"
import {
  ActivityAgent,
  ActivityConversation,
  ActivitySnapshot,
  ActivityQuery,
} from "../contracts"
import { ActivityUnavailable } from "../records"
import type { ActivityDirectory } from "../reader"
import { ACTIVE_AGENTS, agentObjectName } from "../../agents/domain"
import { nativeObservation } from "../../shared/observation"

/** A DTO-only native RPC has no cancellation primitive. The observer may stop
 * at its display deadline; the request's ExecutionContext owns the actual RPC
 * until settlement, including late decoding defects. No stream/resource crosses
 * this capability. The directory is created once per authenticated request. */
export function activityRpc<T>(
  schema: Schema.ConstraintDecoder<T>,
  read: () => Promise<unknown>,
  own: (work: Promise<void>) => void,
  validate: (value: T) => T = (value) => value
): Effect.Effect<T, ActivityUnavailable> {
  return nativeObservation(
    () =>
      read().then((raw) => {
        try {
          return validate(Schema.decodeUnknownSync(schema)(raw))
        } catch (cause) {
          throw Cause.die(cause)
        }
      }),
    own,
    (cause, channel) => {
      const known = Schema.decodeUnknownOption(DirectoryFailure)(cause)
      if (known._tag === "Some")
        return new ActivityUnavailable({ cause: known.value._tag })
      if (channel === "failure" || Schema.isSchemaError(cause)) throw cause
      return new ActivityUnavailable({ cause })
    }
  )
}

export const ActivityRequest = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Snapshot"),
    agent: ActivityAgent,
    query: ActivityQuery,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Conversation"),
    id: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/i)),
    cursor: Schema.NullOr(RunCursor),
  }),
])
const Conversation = Schema.NullOr(ActivityConversation)
export const ActivityResult = Schema.Union([ActivitySnapshot, Conversation])
// The read model keeps private causes locally; only its declared tags cross RPC.
export const ActivityFailure = Schema.Struct({
  _tag: Schema.Literals(["ActivityStorageError", "ActivityUnavailable"]),
})
const DirectoryFailure = Schema.Union([
  ActivityFailure,
  AgentFailure,
  AccountFailure,
])
export const ActivityOutcome = rpcOutcome(
  ActivityResult,
  ActivityFailure,
  "Activity read failed unexpectedly."
)
export interface ActivityReadRpc {
  activityV1?: (input: typeof ActivityRequest.Type) => Promise<unknown>
  readActivity?: (
    agent: ActivityAgent,
    query: typeof ActivityQuery.Type
  ) => Promise<unknown>
  activityConversation?: (
    id: string,
    cursor: typeof RunCursor.Type | null
  ) => Promise<unknown>
}
export type ActivityAgentRpc = ActivityReadRpc &
  AgentRpc &
  Parameters<typeof accountConnectionRpc>[0]

export function activityReadRpc(stub: ActivityReadRpc) {
  const unavailable = () =>
    Promise.reject(
      new ActivityUnavailable({
        cause: "Previous Activity protocol unavailable",
      })
    )
  const invoke = <T>(
    request: typeof ActivityRequest.Type,
    schema: Schema.Codec<T, unknown>,
    legacy: () => Promise<unknown>
  ) => {
    const previous = () =>
      legacy().then((raw) => {
        try {
          return Schema.decodeUnknownSync(schema)(raw)
        } catch (cause) {
          throw Cause.die(cause)
        }
      })
    if (!stub.activityV1) return previous()
    return stub.activityV1(request).then(
      (raw) => ActivityOutcome.unwrap(raw, schema),
      (cause: unknown) => {
        if (Cause.isCause(cause) || Schema.isSchemaError(cause)) throw cause
        return previous()
      }
    )
  }
  return {
    snapshot: (agent: ActivityAgent, query: typeof ActivityQuery.Type) =>
      invoke(
        { _tag: "Snapshot", agent, query },
        ActivitySnapshot,
        () => stub.readActivity?.(agent, query) ?? unavailable()
      ).then((snapshot) => {
        const identity = (value: ActivityAgent) =>
          value.id === agent.id && value.name === agent.name
        if (
          snapshot.entries.some(
            (entry) =>
              !identity(entry.agent) || !entry.key.startsWith(`${agent.id}:`)
          ) ||
          snapshot.issues.some(
            (issue) =>
              !identity(issue.agent) || !issue.key.startsWith(`${agent.id}:`)
          )
        )
          throw Cause.die("Activity snapshot belongs to a different bot.")
        return snapshot
      }),
    conversation: (id: string, cursor: typeof RunCursor.Type | null) =>
      invoke(
        { _tag: "Conversation", id, cursor },
        Conversation,
        () => stub.activityConversation?.(id, cursor) ?? unavailable()
      ).then((record) => {
        if (record && record.id !== id)
          throw Cause.die(
            "Activity record belongs to a different conversation."
          )
        return record
      }),
  }
}
export function activityDirectory(
  owner: string,
  root: AgentRpc & Parameters<typeof accountConnectionRpc>[0],
  lookup: (name: string) => ActivityReadRpc,
  own: (work: Promise<void>) => void
): ActivityDirectory {
  const call = <T>(
    schema: Schema.ConstraintDecoder<T>,
    read: () => Promise<unknown>,
    validate?: (value: T) => T
  ) => activityRpc(schema, read, own, validate)
  return {
    agents: () =>
      call(
        Schema.Array(ActivityAgent).check(Schema.isMaxLength(ACTIVE_AGENTS)),
        () => agentRpc(root).contacts(),
        (agents) => {
          if (new Set(agents.map((agent) => agent.id)).size !== agents.length)
            throw new Error("Duplicate activity catalog identity.")
          return agents
        }
      ),
    find: (id) =>
      call(Schema.NullOr(ActivityAgent), () => agentRpc(root).profile(id)),
    connected: () =>
      call(Schema.Boolean, () => accountConnectionRpc(root).connected()),
    snapshot: (agent, query) =>
      call(ActivitySnapshot, () =>
        activityReadRpc(lookup(agentObjectName(owner, agent.id))).snapshot(
          agent,
          query
        )
      ),
    conversation: (agent, id, cursor) =>
      call(Conversation, () =>
        activityReadRpc(lookup(agentObjectName(owner, agent.id))).conversation(
          id,
          cursor
        )
      ),
  }
}
