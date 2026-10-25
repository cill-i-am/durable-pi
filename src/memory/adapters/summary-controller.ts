import {
  initialSummaryController,
  readSummaryController,
  type SummaryController,
} from "../summary-discovery.machine"

const controllerKey = "memory-compactor:failure"

/** Storage owns the controller. A failed final write retains spent authority in
 * the warm host so an ordinary wake cannot silently grant another attempt. */
export class SummaryControllerRecord {
  private unpersisted?: SummaryController
  private observed?: SummaryController
  constructor(private readonly storage: () => DurableObjectStorage) {}

  get admissionAvailable() {
    return !this.unpersisted && this.observed?.phase !== "exhausted"
  }

  async read() {
    if (this.unpersisted) return this.unpersisted
    const raw = await this.storage().get(controllerKey)
    const control =
      raw === undefined
        ? initialSummaryController()
        : readSummaryController(raw)
    this.observed = control
    return control
  }

  async commit(next: SummaryController) {
    await this.storage().put(controllerKey, next)
    this.observed = next
    this.unpersisted = undefined
  }

  async retainExhaustion(next: SummaryController) {
    this.unpersisted = next
    await this.commit(next)
  }
}
