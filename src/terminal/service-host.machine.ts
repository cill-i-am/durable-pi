import { setupEffect } from "@xstate/effect"
import { Deferred, Schema } from "effect"
import { matchesState } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

export const terminalCleanupMessage =
  "The command outcome or container cleanup could not be confirmed. Retry recovery before running another command."
export type HostPermission = "allow" | "join" | "stopped" | "cleanup" | "active"
export type HostCheck = "open" | "resources" | "recover"
export type HostObservation =
  | "CLOSE"
  | "RECOVERY_STARTED"
  | "RECOVERY_FINISHED"
  | "CLEANUP_FAILED"
const ack = Schema.declare((value): value is Deferred.Deferred<void> =>
  Deferred.isDeferred(value)
)
const reply = Schema.declare(
  (value): value is Deferred.Deferred<HostPermission> =>
    Deferred.isDeferred(value)
)
const response = Schema.Struct({
  reply,
  permission: Schema.Literals([
    "allow",
    "join",
    "stopped",
    "cleanup",
    "active",
  ]),
})

/** Local admission and cleanup knowledge only. The service scope owns this
 * actor; command/occupancy ledgers and native fibers retain their own ownership. */
export const terminalServiceHostMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Schema.Struct({ cleanupError: Schema.NullOr(Schema.String) }),
    events: {
      CHECK: Schema.Struct({
        mode: Schema.Literals(["open", "resources", "recover"]),
        active: Schema.Boolean,
        reply,
      }),
      CONFIGURE_NETWORK: Schema.Struct({ active: Schema.Boolean }),
      CLOSE: Schema.Struct({ ack }),
      RECOVERY_STARTED: Schema.Struct({ ack }),
      RECOVERY_FINISHED: Schema.Struct({ ack }),
      CLEANUP_FAILED: Schema.Struct({ ack }),
    },
  },
  actions: {
    respond: ({ params }: { params?: unknown }) => {
      const input = Schema.decodeUnknownSync(response)(params)
      return Deferred.succeed(input.reply, input.permission)
    },
    acknowledge: ({ params }: { params?: unknown }) =>
      Deferred.succeed(Schema.decodeUnknownSync(ack)(params), undefined),
  },
}).createMachine({
  id: "terminal-service-host",
  type: "parallel",
  context: { cleanupError: null },
  on: {
    CHECK: (args, enq) => {
      const { event, value, context } = args
      const recovering = matchesState({ cleanup: "recovering" }, value)
      const permission: HostPermission =
        event.mode === "recover" && recovering
          ? "join"
          : event.mode !== "resources" &&
              matchesState({ admission: "closed" }, value)
            ? "stopped"
            : event.mode === "recover" && event.active
              ? "active"
              : event.mode === "resources" &&
                  (event.active || recovering || context.cleanupError !== null)
                ? "cleanup"
                : "allow"
      enq(args.actions.respond, {
        ...args,
        params: { reply: event.reply, permission },
      })
    },
  },
  states: {
    admission: {
      initial: "open",
      on: {
        CLOSE: (args, enq) => {
          enq(args.actions.acknowledge, { ...args, params: args.event.ack })
          return { target: ".closed" }
        },
      },
      states: { open: {}, closed: {} },
    },
    cleanup: {
      initial: "ready",
      on: {
        RECOVERY_STARTED: (args, enq) => {
          enq(args.actions.acknowledge, { ...args, params: args.event.ack })
          return { target: ".recovering", context: { cleanupError: null } }
        },
        CLEANUP_FAILED: (args, enq) => {
          enq(args.actions.acknowledge, { ...args, params: args.event.ack })
          return {
            target: ".blocked",
            context: { cleanupError: terminalCleanupMessage },
          }
        },
      },
      states: {
        ready: {
          on: {
            CONFIGURE_NETWORK: ({ event }) =>
              event.active ? undefined : { target: "ready" },
          },
        },
        blocked: {},
        recovering: {
          initial: "clean",
          on: {
            CLEANUP_FAILED: (args, enq) => {
              enq(args.actions.acknowledge, { ...args, params: args.event.ack })
              return {
                target: ".uncertain",
                context: { cleanupError: terminalCleanupMessage },
              }
            },
            RECOVERY_FINISHED: (args, enq) => {
              enq(args.actions.acknowledge, { ...args, params: args.event.ack })
              return {
                target:
                  args.context.cleanupError === null
                    ? "#terminal-service-host.cleanup.ready"
                    : "#terminal-service-host.cleanup.blocked",
              }
            },
          },
          states: { clean: {}, uncertain: {} },
        },
      },
    },
  },
})
