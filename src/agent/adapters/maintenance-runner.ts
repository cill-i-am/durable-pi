import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle"

import { reportHarness } from "../../observability/events"

const HEARTBEAT_MS = 30_000

type Completion = { revision: number } & (
  | { ok: true; next: number | undefined }
  | { ok: false; error: unknown }
)

/** Keep slow maintenance outside alarm dispatch. The persisted job remains a
 * recovery backstop; only its current attempt and result live in memory. */
export class MaintenanceRunner extends LifecycleCapability {
  private pending: Promise<void> | undefined
  private completion: Completion | undefined
  private revision = 0

  constructor(
    capability: string,
    private readonly run: () => Promise<number | undefined>,
    private readonly retain: (work: Promise<void>) => void
  ) {
    super(capability)
  }

  private schedule(time: number) {
    return this.lifecycle.jobs.push({
      id: `${this.capabilityId}:pump`,
      fn: "pump",
      time,
      singleflight: true,
      hungTimeoutSeconds: 600,
      recoveryLoop: true,
    })
  }

  async wake() {
    this.revision++
    await this.schedule(Date.now())
  }

  async onJob(): Promise<LifecycleJobOutcome> {
    const heartbeat = { rescheduleAt: Date.now() + HEARTBEAT_MS }
    if (this.pending) return heartbeat
    if (this.completion) {
      const result = this.completion
      if (!result.ok) throw result.error
      this.completion = undefined
      // A wake during this attempt may refer to work after its last read.
      if (result.revision !== this.revision) return { rescheduleAt: Date.now() }
      return result.next === undefined
        ? undefined
        : { rescheduleAt: result.next }
    }
    const revision = this.revision
    const work = Promise.resolve()
      .then(() => this.run())
      .then(
        (next) => {
          this.completion = { revision, ok: true, next }
        },
        (error: unknown) => {
          this.completion = { revision, ok: false, error }
          throw error
        }
      )
      .finally(async () => {
        this.pending = undefined
        await this.schedule(Date.now())
      })
    this.pending = work
    this.lifecycle.trackAlarmWork(work)
    this.retain(work)
    return heartbeat
  }

  onJobError(
    _context: LifecycleJobContext,
    error: unknown
  ): LifecycleJobOutcome {
    this.completion = undefined
    reportHarness(error, "personal")
    return { rescheduleAt: Date.now() + 10_000 }
  }
}
