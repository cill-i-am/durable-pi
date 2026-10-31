import { expect, it } from "vitest"
import { initialTransition, transition, type AnyStateMachine } from "xstate"

import { oauthBindingMachine } from "../src/access/oauth-binding.machine"
import { taskReleaseMachine } from "../src/communication/release.machine"
import { controlReleaseMachine } from "../src/conversations/control-release.machine"
import { objectStoreMachine } from "../src/features/objects/object-store.machine"
import {
  summaryControllerRecordMachine,
  backupControllerRecordMachine,
} from "../src/memory/controller-record.machine"
import { reportAdmissionMachine } from "../src/observability/browser-report.machine"

const invalid: { machine: AnyStateMachine; event: unknown }[] = [
  { machine: oauthBindingMachine, event: { type: "BIND", id: 123 } },
  { machine: taskReleaseMachine, event: { type: "RETAIN", receipt: {} } },
  { machine: controlReleaseMachine, event: { type: "RETAIN", receipt: {} } },
  { machine: objectStoreMachine, event: { type: "FAILED", error: 123 } },
  {
    machine: summaryControllerRecordMachine,
    event: { type: "RETAIN", record: {} },
  },
  {
    machine: backupControllerRecordMachine,
    event: { type: "RETAIN", record: {} },
  },
  {
    machine: reportAdmissionMachine,
    event: { type: "REPORT", now: "later", known: false },
  },
]
it.each(invalid)(
  "rejects malformed events before advancing $machine.id",
  ({ machine, event }) => {
    const [state] = initialTransition(machine)
    const [next, effects] = transition(machine, state, event as never)
    expect(next.value).toEqual(state.value)
    expect(next.context).toEqual(state.context)
    expect(effects).toContainEqual(
      expect.objectContaining({
        type: "@xstate.deadLetter",
        reason: "invalidEvent",
      })
    )
  }
)

const releases: {
  machine: AnyStateMachine
  receipt: Record<string, unknown>
}[] = [
  {
    machine: controlReleaseMachine,
    receipt: {
      owner: "one",
      rootId: "root",
      confirmed: false,
      result: { phase: "stop", failed: true, timedOut: true, inspected: false },
    },
  },
  {
    machine: taskReleaseMachine,
    receipt: {
      owner: "one",
      taskId: "11111111-1111-4111-8111-111111111111",
      revision: 1,
      now: 100,
      stop: "unconfirmed",
      failed: true,
    },
  },
]
it.each(releases)(
  "$machine.id retains exact receipts across duplicate and stale acknowledgements",
  ({ machine, receipt }) => {
    const [initial] = initialTransition(machine)
    const [pending] = transition(machine, initial, { type: "RETAIN", receipt })
    expect(pending.matches("pending")).toBe(true)
    const [duplicate] = transition(machine, pending, {
      type: "RETAIN",
      receipt,
    })
    expect(duplicate.context.receipts).toEqual([receipt])
    expect(() =>
      transition(machine, pending, {
        type: "RETAIN",
        receipt: {
          ...receipt,
          owner: "one",
          ...("rootId" in receipt ? { rootId: "other" } : { revision: 2 }),
        },
      })
    ).toThrow("identity changed")
    const [stale] = transition(machine, pending, {
      type: "RELEASED",
      receipt: { ...receipt, owner: "other" },
    })
    expect(stale.context.receipts).toEqual([receipt])
    const [released] = transition(machine, stale, { type: "RELEASED", receipt })
    expect(released.matches("clear")).toBe(true)
    expect(released.context.receipts).toEqual([])
  }
)
