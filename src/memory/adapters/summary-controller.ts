import { initialTransition, transition } from "xstate"

import { summaryControllerRecordMachine as machine } from "../controller-record.machine"
import {
  initialSummaryController,
  readSummaryController,
  type SummaryController,
} from "../summary-discovery.machine"

const controllerKey = "memory-compactor:failure"

/** Storage owns the controller. A failed final write retains spent authority in
 * the warm host so an ordinary wake cannot silently grant another attempt. */
export class SummaryControllerRecord {
  private state = initialTransition(machine)[0]
  constructor(private readonly storage: () => DurableObjectStorage) {}

  get admissionAvailable() {
    return this.state.can({ type: "ADMIT" })
  }

  async read() {
    if (this.state.matches("retained")) return this.state.context.retained!
    const generation = this.state.context.generation
    const raw = await this.storage().get(controllerKey)
    const control =
      raw === undefined
        ? initialSummaryController()
        : readSummaryController(raw)
    this.state = transition(machine, this.state, {
      type: "OBSERVED",
      record: control,
      generation,
    })[0]
    return this.state.context.retained ?? this.state.context.observed ?? control
  }

  async commit(next: SummaryController) {
    next = readSummaryController(next)
    const generation = this.state.context.generation
    await this.storage().put(controllerKey, next)
    this.state = transition(machine, this.state, {
      type: "COMMITTED",
      record: next,
      generation,
    })[0]
  }

  async retainExhaustion(next: SummaryController) {
    next = readSummaryController(next)
    this.state = transition(machine, this.state, {
      type: "RETAIN",
      record: next,
    })[0]
    await this.commit(next)
  }
}
