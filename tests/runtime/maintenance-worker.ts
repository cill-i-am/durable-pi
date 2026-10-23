import { Lifecycle, LifecycleCapability } from "agents/lifecycle"
import { DurableObject } from "cloudflare:workers"
import { Effect } from "effect"

import { SummaryRunner } from "../../src/memory/adapters/summary-lifecycle"

class ForegroundProbe extends LifecycleCapability {
  constructor(private readonly tick: () => void) {
    super("foreground-probe")
  }
  async wake() {
    await this.lifecycle.jobs.push({
      id: "foreground-probe",
      fn: "tick",
      time: Date.now(),
    })
  }
  onJob() {
    this.tick()
  }
}

/** Production summary runner alarm fairness with synthetic, replayable work.
 * Summary claim/uncertainty semantics are proved by memory-summary-worker. */
export class MaintenanceProbe extends DurableObject<Record<string, never>> {
  private release: (() => void) | undefined
  readonly maintenance = new SummaryRunner<never>({
    run: (work, options) => Effect.runPromise(work, options),
    step: () =>
      Effect.promise(async () => {
        const requested = this.info().requested
        this.ctx.storage.sql.exec(
          "UPDATE maintenance_fixture SET calls=calls+1"
        )
        if (this.info().held)
          await new Promise<void>((resolve) => {
            this.release = resolve
          })
        this.ctx.storage.sql.exec(
          "UPDATE maintenance_fixture SET applied=?",
          requested
        )
        return undefined
      }),
    settle: () => Effect.void,
    nextWake: () =>
      Effect.sync(() => {
        const state = this.info()
        return state.requested > state.applied ? Date.now() : undefined
      }),
    restore: () => Effect.void,
    retain: (work) => this.ctx.waitUntil(work),
  })
  readonly foreground = new ForegroundProbe(() => {
    this.ctx.storage.sql.exec("UPDATE maintenance_fixture SET ticks=ticks+1")
  })
  readonly lifecycle = Lifecycle.install(this)
    .use(this.maintenance)
    .use(this.foreground)

  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env)
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS maintenance_fixture (requested INTEGER,applied INTEGER,calls INTEGER,ticks INTEGER,held INTEGER)"
    )
    ctx.storage.sql.exec(
      "INSERT INTO maintenance_fixture SELECT 0,0,0,0,0 WHERE NOT EXISTS (SELECT 1 FROM maintenance_fixture)"
    )
  }
  private info() {
    return this.ctx.storage.sql
      .exec<{
        requested: number
        applied: number
        calls: number
        ticks: number
        held: number
      }>("SELECT * FROM maintenance_fixture")
      .one()
  }
  async fetch(request: Request) {
    const action = new URL(request.url).pathname.split("/").at(-1)
    if (action === "start") {
      this.ctx.storage.sql.exec(
        "UPDATE maintenance_fixture SET held=1,requested=requested+1"
      )
      await this.maintenance.wake()
    }
    if (action === "new-work") {
      this.ctx.storage.sql.exec(
        "UPDATE maintenance_fixture SET requested=requested+1"
      )
      await this.maintenance.wake()
    }
    if (action === "foreground") await this.foreground.wake()
    if (action === "release") {
      this.ctx.storage.sql.exec("UPDATE maintenance_fixture SET held=0")
      this.release?.()
      await this.maintenance.wake()
    }
    return Response.json({
      ...this.info(),
      jobs: [
        ...this.ctx.storage.sql.exec<{ id: string; time: number }>(
          "SELECT id,time FROM cf_agents_jobs WHERE capability='memory-compactor'"
        ),
      ],
    })
  }
}
