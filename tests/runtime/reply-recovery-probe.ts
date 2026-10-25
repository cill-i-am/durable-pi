import { Lifecycle } from "agents/lifecycle"
import { DurableObject } from "cloudflare:workers"
import { Clock, Deferred, Effect, Scope } from "effect"

import { homeAgentId } from "../../src/agents/domain"
import { sendEmailReply } from "../../src/email/adapters/sending"
import { EmailStore } from "../../src/email/adapters/sqlite"
import { emailPump } from "../../src/email/pump"
import { ReplyRunner } from "../../src/replies/adapters/lifecycle"
import { admitReply } from "../../src/replies/admission"
import { REPLY_LEASE_MS } from "../../src/replies/contracts"
import { WhatsAppStore } from "../../src/whatsapp/adapters/sqlite"
import { whatsappPump } from "../../src/whatsapp/pump"
import { nativeDatabase } from "./database"

class FixtureRunner extends ReplyRunner<unknown> {
  jobs() {
    return this.lifecycle.jobs.list()
  }
  due(fn: string, at = Date.now()) {
    return this.lifecycle.jobs.reschedule(
      `${this.channel}:${fn === "recover" ? "reply-recovery" : "pump"}`,
      at
    )
  }
}

/** The production reply capability, pumps and ledgers under the real Lifecycle
 * queue. Only the provider and fault barriers are synthetic. */
class ReplyRecoveryProbe extends DurableObject<Record<string, never>> {
  readonly scope = Scope.makeUnsafe()
  sqlUnavailable = false
  sqlFaultReads = 0
  readonly faultSql = new Proxy(this.ctx.storage.sql, {
    get: (target, key) => {
      const member: unknown = Reflect.get(target, key, target)
      if (key === "exec")
        return (...args: unknown[]) => {
          if (this.sqlUnavailable) {
            this.sqlFaultReads++
            throw new Error("fixture all SQLite unavailable")
          }
          return Reflect.apply(target.exec, target, args) as unknown
        }
      return typeof member === "function" ? member.bind(target) : member
    },
  })
  readonly faultStorage = new Proxy(this.ctx.storage, {
    get: (target, key) => {
      if (key === "sql") return this.faultSql
      const member: unknown = Reflect.get(target, key, target)
      return typeof member === "function" ? member.bind(target) : member
    },
  })
  readonly faultContext = new Proxy(this.ctx, {
    get: (target, key) => {
      if (key === "storage") return this.faultStorage
      const member: unknown = Reflect.get(target, key, target)
      return typeof member === "function" ? member.bind(target) : member
    },
  })
  readonly db = nativeDatabase(this.faultStorage, this.scope)
  readonly email = new EmailStore(this.db)
  readonly whatsapp = new WhatsAppStore(this.db)
  readonly id = "88888888-8888-4888-8888-888888888888"
  readonly otherId = "99999999-9999-4999-8999-999999999999"
  holdAlarm = true
  holdScan = false
  scanned = false
  release = Deferred.makeUnsafe<void>()
  holdExhaust = false
  exhaustReady = false
  releaseExhaust = Deferred.makeUnsafe<void>()
  offset = 0
  failPump = false
  failDiscovery = false
  failures = 0
  holdProvider = false
  providerStarted = false
  providerRelease: ((receipt: string) => void) | undefined
  readonly providerResult = new Promise<string>((resolve) => {
    this.providerRelease = resolve
  })
  readonly liveClock = Effect.runSync(Clock.Clock)
  readonly clock: Clock.Clock = {
    currentTimeMillis: Effect.sync(() => Date.now() + this.offset),
    currentTimeMillisUnsafe: () => Date.now() + this.offset,
    currentTimeNanos: this.liveClock.currentTimeNanos,
    currentTimeNanosUnsafe: () => this.liveClock.currentTimeNanosUnsafe(),
    monotonicTimeNanos: this.liveClock.monotonicTimeNanos,
    monotonicTimeNanosUnsafe: () => this.liveClock.monotonicTimeNanosUnsafe(),
    sleep: (duration) => this.liveClock.sleep(duration),
  }
  run = <A>(work: Effect.Effect<A, unknown>) =>
    Effect.runPromise(work.pipe(Effect.provideService(Clock.Clock, this.clock)))
  readonly runner: FixtureRunner
  readonly lifecycle: Lifecycle<Record<string, never>>
  constructor(
    ctx: DurableObjectState,
    env: Record<string, never>,
    readonly channel: "email" | "whatsapp"
  ) {
    super(ctx, env)
    this.db.run(
      "CREATE TABLE IF NOT EXISTS fixture_discovery (pumps INTEGER, sends INTEGER, automatic INTEGER, lastSend INTEGER, work INTEGER)"
    )
    if (!this.db.all("SELECT * FROM fixture_discovery").length)
      this.db.run("INSERT INTO fixture_discovery VALUES (0,0,0,0,0)")
    // Restart begins with alarms enabled; the initial request explicitly holds them.
    this.holdAlarm = false
    this.runner = new FixtureRunner(channel, {
      run: this.run,
      pump: async () => {
        this.db.run("UPDATE fixture_discovery SET pumps=pumps+1")
        if (this.failPump) {
          this.failures++
          throw new Error("fixture pump unavailable")
        }
        const next = await this.run(this.pump())
        return next === undefined ? undefined : { rescheduleAt: next }
      },
      recover: () =>
        Effect.suspend((): Effect.Effect<void, unknown> => {
          if (this.failDiscovery) {
            this.failures++
            return Effect.die("fixture discovery unavailable")
          }
          return this.store.recover(false)
        }),
      exhaust: (eligible, expiredOnly) =>
        Effect.gen({ self: this }, function* () {
          if (this.holdExhaust) {
            this.exhaustReady = true
            yield* Deferred.await(this.releaseExhaust)
          }
          yield* this.store.exhaustRecovery(eligible, expiredOnly)
        }),
      pending: () =>
        Effect.gen({ self: this }, function* () {
          const rows = yield* this.store.pending()
          if (this.holdScan) {
            this.scanned = true
            yield* Deferred.await(this.release)
          }
          return rows
        }),
      nextRecovery: () => this.store.nextRecovery(),
    })
    // Both owners touch the same real SQLite connection through this fault
    // aperture. No queue rows, callbacks or outcomes are simulated.
    const host = new Proxy(this, {
      get: (target, key) =>
        key === "ctx" ? this.faultContext : Reflect.get(target, key, target),
    })
    this.lifecycle = new Lifecycle(host).use(this.runner)
  }
  get store() {
    return this.channel === "email" ? this.email : this.whatsapp
  }
  async onStart() {
    await this.runner.reconcile()
    await this.run(this.store.recover())
    if (
      (await this.run<readonly { state: string }[]>(this.store.pending()))
        .length
    )
      await this.runner.wake()
  }
  async alarm() {
    if (this.holdAlarm) return
    this.db.run("UPDATE fixture_discovery SET automatic=automatic+1")
    await this.lifecycle.alarm()
  }
  pump() {
    const host = {
      armReply: (deadline: number) =>
        Effect.promise(() => this.runner.armReply(deadline)),
      active: () => Effect.succeed(true),
      control: () =>
        Effect.sync(() => {
          this.db.run("UPDATE fixture_discovery SET work=work+1")
          return "Native recovery completed"
        }),
      admit: () => Effect.void,
      turn: () => Effect.succeed(undefined),
      send: () =>
        Effect.gen({ self: this }, function* () {
          this.db.run(
            "UPDATE fixture_discovery SET sends=sends+1,lastSend=?",
            Date.now()
          )
          if (this.holdProvider && !this.providerStarted) {
            this.providerStarted = true
            // A provider Promise may outlive local cancellation. Its late result
            // must never checkpoint a timed-out attempt or overwrite a retry.
            return yield* Effect.promise(() => this.providerResult)
          }
          return "provider-confirmed"
        }),
    }
    return this.channel === "email"
      ? emailPump(this.email, {
          ...host,
          send: (record, reply) =>
            sendEmailReply(
              {
                send: async () => ({ messageId: await this.run(host.send()) }),
              },
              record,
              reply
            ),
          reviewUrl: () => Effect.succeed("https://pi.example/"),
        })()
      : whatsappPump(this.whatsapp, {
          ...host,
          name: () => Effect.succeed("Home"),
          reviewUrl: () => "https://pi.example/",
        })()
  }
  accept(deadline: number, id = this.id) {
    const base = { id, fingerprint: "c".repeat(64), body: "STATUS" }
    return this.channel === "email"
      ? this.email
          .receive(
            {
              ...base,
              messageId: `<${id}@example.com>`,
              sender: "owner@example.com",
              recipient: "private@example.com",
              subject: "Discovery",
              references: "",
            },
            1,
            deadline
          )
          .pipe(Effect.orDie)
      : this.whatsapp
          .receive(
            {
              ...base,
              messageId: `wamid.${id}`,
              sender: "15550101010",
              threadId: "whatsapp:123456:15550101010",
              timestamp: Date.now(),
            },
            homeAgentId,
            {},
            deadline
          )
          .pipe(Effect.orDie)
  }
  async fault(action: string | undefined) {
    if (action === "fault-pump") this.failPump = true
    if (action === "fault-discovery") this.failDiscovery = true
    if (action === "hold-provider") this.holdProvider = true
    if (action === "release-provider") this.providerRelease?.("provider-late")
    if (action === "fault-checkpoint")
      this.db.run(
        `CREATE TRIGGER fixture_reply_fault BEFORE UPDATE ON ${this.channel}_messages WHEN OLD.state='sending' AND (NEW.delivery IS NOT OLD.delivery OR NEW.state!='sending') BEGIN SELECT RAISE(ABORT,'fixture receipt/recovery storage unavailable'); END`
      )
    if (action === "retry")
      await this.run(
        admitReply({
          arm: (deadline) =>
            Effect.promise(() => this.runner.armReply(deadline)),
          accept: (deadline): Effect.Effect<void, unknown> =>
            this.store.retry(this.id, true, crypto.randomUUID(), deadline),
          wake: Effect.promise(() => this.runner.wake()),
        })
      )
  }
  async outage(action: string | undefined) {
    if (action === "fault-terminal")
      this.db.run(
        `CREATE TRIGGER fixture_reply_outage BEFORE UPDATE ON ${this.channel}_messages BEGIN SELECT RAISE(ABORT,'fixture terminal storage unavailable'); END`
      )
    if (action === "fault-finish")
      this.db.run(
        `CREATE TRIGGER fixture_reply_fault BEFORE UPDATE ON ${this.channel}_messages WHEN OLD.state='sending' AND NEW.state!='sending' BEGIN SELECT RAISE(ABORT,'fixture final outcome storage unavailable'); END`
      )
    if (action === "heal-outage") {
      this.db.run("DROP TRIGGER IF EXISTS fixture_reply_outage")
      this.db.run("DROP TRIGGER IF EXISTS fixture_reply_fault")
      this.failPump = false
      this.failDiscovery = false
    }
    if (action === "reconcile") await this.runner.reconcile()
    if (action === "hold-exhaust") {
      this.holdExhaust = true
      this.exhaustReady = false
      this.releaseExhaust = Deferred.makeUnsafe<void>()
    }
    if (action === "release-exhaust") {
      this.holdExhaust = false
      await this.run(Deferred.succeed(this.releaseExhaust, undefined))
    }
    if (action === "admit-other")
      await this.run(
        admitReply({
          arm: (deadline) =>
            Effect.promise(() => this.runner.armReply(deadline)),
          accept: (deadline) => this.accept(deadline, this.otherId),
          wake: Effect.void,
        })
      )
  }
  async snapshot() {
    return {
      row: (await this.run<unknown>(this.store.get(this.id))) ?? null,
      other: (await this.run<unknown>(this.store.get(this.otherId))) ?? null,
      jobs: this.runner.jobs(),
      failures: this.failures,
      scanned: this.scanned,
      exhaustReady: this.exhaustReady,
      providerStarted: this.providerStarted,
      metrics: this.db.all("SELECT * FROM fixture_discovery")[0],
      now: Date.now(),
      leaseMs: REPLY_LEASE_MS,
    }
  }
  async exerciseSqlOutage() {
    const failures: string[] = []
    for (const operation of [
      () => this.lifecycle.alarm(),
      () => this.runner.reconcile(),
    ]) {
      try {
        await operation()
      } catch (error) {
        failures.push(String(error))
      }
    }
    return Response.json({ failures, faults: this.sqlFaultReads })
  }
  async fetch(request: Request) {
    const url = new URL(request.url),
      action = url.pathname.split("/").at(-1)
    // Keep synthetic fault switches in the same live object across the real
    // provider-minute wait; this request performs no domain or queue work.
    if (action === "keep-alive")
      return Response.json({ sqlUnavailable: this.sqlUnavailable })
    await this.lifecycle.start()
    if (action === "fault-all-sql") {
      this.sqlUnavailable = true
      return Response.json({ unavailable: true })
    }
    if (action === "exercise-all-sql") return this.exerciseSqlOutage()
    if (action === "heal-all-sql") this.sqlUnavailable = false
    if (action === "setup") {
      this.holdAlarm = true
      if (this.channel === "whatsapp")
        await this.run(
          this.whatsapp.configure(
            { operationId: crypto.randomUUID(), enabled: true, revision: 0 },
            homeAgentId
          )
        )
    }
    if (action === "arm")
      await this.runner.armReply(Number(url.searchParams.get("deadline")))
    if (action === "due") await this.runner.due("recover")
    if (action === "hold-scan") {
      this.holdScan = true
      this.release = Deferred.makeUnsafe<void>()
    }
    if (action === "dispatch") await this.lifecycle.alarm()
    if (action === "accept")
      await this.run(this.accept(Number(url.searchParams.get("deadline"))))
    if (action === "release") {
      this.offset = Number(url.searchParams.get("offset") ?? 0)
      this.holdScan = false
      await this.run(Deferred.succeed(this.release, undefined))
    }
    await this.fault(action)
    await this.outage(action)
    if (action === "wake") await this.runner.wake()
    if (action === "pump-due") await this.runner.due("pump")
    if (action === "heal") {
      this.db.run("DROP TRIGGER fixture_reply_fault")
      this.offset = 61_000
      await this.runner.due("recover")
      await this.runner.due("pump")
    }
    if (action === "lost-wake") {
      const exit = await this.run(
        Effect.exit(
          admitReply({
            arm: (deadline) =>
              Effect.promise(() => this.runner.armReply(deadline)),
            accept: (deadline) => this.accept(deadline),
            wake: Effect.die("fixture wake acknowledgement lost"),
          })
        )
      )
      if (exit._tag !== "Failure")
        throw new Error("Wake fault was not exercised")
    }
    if (action === "arm-restart")
      await this.runner.due("recover", Date.now() + 1000)
    return Response.json(await this.snapshot())
  }
}
export class EmailRecoveryProbe extends ReplyRecoveryProbe {
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env, "email")
  }
}
export class WhatsAppRecoveryProbe extends ReplyRecoveryProbe {
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env, "whatsapp")
  }
}
