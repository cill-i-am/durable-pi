import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { BackupController } from "./backup-discovery.machine"
import { SummaryController } from "./summary-discovery.machine"

/** Local write acknowledgement, never another durable recovery budget.
 * A read or write started before a retained exhaustion cannot clear that fence. */
function controllerRecordMachine(record: Schema.Codec<BackupController>) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        observed: Schema.UndefinedOr(record),
        retained: Schema.UndefinedOr(record),
        generation: Schema.Number,
      }),
      events: {
        OBSERVED: Schema.Struct({ record, generation: Schema.Number }),
        RETAIN: Schema.Struct({ record }),
        COMMITTED: Schema.Struct({ record, generation: Schema.Number }),
        ADMIT: Schema.Struct({}),
      },
    },
  }).createMachine({
    id: "memory-controller-record",
    initial: "observing",
    context: () => ({
      observed: undefined as BackupController | undefined,
      retained: undefined as BackupController | undefined,
      generation: 0,
    }),
    on: {
      RETAIN: ({ context, event }) => ({
        target: ".retained",
        context: {
          ...context,
          retained: event.record,
          generation: context.generation + 1,
        },
      }),
      COMMITTED: ({ context, event }) =>
        event.generation !== context.generation
          ? undefined
          : {
              target: ".observing",
              context: {
                ...context,
                observed: event.record,
                retained: undefined,
              },
            },
    },
    states: {
      observing: {
        on: {
          OBSERVED: ({ context, event }) =>
            event.generation !== context.generation
              ? undefined
              : {
                  context: { ...context, observed: event.record },
                },
          ADMIT: ({ context }) =>
            context.observed?.phase === "exhausted" ? undefined : {},
        },
      },
      retained: {},
    },
  })
}
export const summaryControllerRecordMachine =
  controllerRecordMachine(SummaryController)
export const backupControllerRecordMachine =
  controllerRecordMachine(BackupController)
