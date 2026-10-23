import { Effect } from "effect"

import { AppEventRunner } from "../../src/apps/adapters/lifecycle"
import { AppStore } from "../../src/apps/adapters/sqlite"
import type { InteractApp } from "../../src/apps/contracts"
import { appEventPump } from "../../src/apps/pump"
import { makeApps } from "../../src/apps/service"
import { observeConversationSchedule } from "../../src/conversations/adapters/lifecycle"
import { ConversationControlProbe } from "./conversation-control-worker"

class ProbeAppRunner extends AppEventRunner<unknown> {
  jobs() {
    return this.lifecycle.jobs.list()
  }
}

/** The inherited fixture supplies the production Conversation store/journal,
 * scoped pump, runner and native Pi Harness with a synthetic model. Apps uses
 * its production store, shared admission transaction, scoped pump and runner.
 * Authority/model availability are synthetic. No remote renderer or provider
 * side effects are exercised by this checklist interaction. */
export class AppsProbe extends ConversationControlProbe {
  readonly appStore = new AppStore(this.db, () => Effect.succeed(true))
  readonly apps = makeApps(this.appStore)
  readonly appPump = appEventPump(this.apps, {
    active: () => Effect.succeed(true),
    modelConnected: () => Effect.succeed(true),
    prearm: () =>
      observeConversationSchedule("arm app continuation", () =>
        this.runner.armDiscovery()
      ),
    admission: {
      transactionGroup: this.db,
      admit: (event, discoveryDeadline) =>
        this.store
          .admit(
            { operationId: event.turnId, text: event.text },
            undefined,
            [],
            undefined,
            { discoveryDeadline }
          )
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                this.db.run("UPDATE apps_probe SET admissions=admissions+1")
              })
            ),
            Effect.map(({ turn }) => turn.id)
          ),
    },
    wakeConversation: () =>
      observeConversationSchedule("wake app continuation", () =>
        this.runner.wake()
      ),
    notify: () => Effect.void,
  })
  readonly appRunner: ProbeAppRunner = new ProbeAppRunner({
    run: (work) => Effect.runPromise(work),
    pump: async () => {
      this.db.run("UPDATE apps_probe SET passes=passes+1")
      if (this.probe().fail_scan)
        throw new Error("Synthetic Apps storage scan unavailable")
      return Effect.runPromise(this.appPump.run())
    },
    next: () => this.apps.nextDelivery(),
    exhaust: (eligible, expiredOnly) =>
      this.apps.exhaustDelivery(eligible, expiredOnly),
  })
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env)
    this.db.run(
      "CREATE TABLE IF NOT EXISTS apps_probe(deadline INTEGER,input TEXT,passes INTEGER NOT NULL,admissions INTEGER NOT NULL,fail_scan INTEGER NOT NULL)"
    )
    if (!this.db.all("SELECT * FROM apps_probe").length)
      this.db.run("INSERT INTO apps_probe VALUES(NULL,NULL,0,0,0)")
    this.lifecycle.use(this.appRunner)
  }
  override async onStart() {
    await super.onStart()
    await this.appRunner.reconcile()
  }
  private probe() {
    return this.db.all<{
      deadline: number | null
      input: string | null
      passes: number
      admissions: number
      fail_scan: number
    }>("SELECT * FROM apps_probe")[0]!
  }
  private async setup() {
    this.holdAlarm = true
    const draft = await Effect.runPromise(
      this.apps.save({
        id: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        expectedRevision: 0,
        definition: {
          title: "Native Apps recovery proof",
          description: "Synthetic checklist interaction",
          blocks: [
            {
              id: "tasks",
              type: "checklist",
              title: "Tasks",
              items: [{ id: "proof", label: "Prove durable admission" }],
            },
          ],
        },
      })
    )
    const published = await Effect.runPromise(
      this.apps.publish({
        id: draft.id,
        operationId: crypto.randomUUID(),
        expectedRevision: draft.revision,
        version: draft.version,
      })
    )
    const input: InteractApp = {
      id: published.id,
      operationId: crypto.randomUUID(),
      expectedRevision: published.revision,
      version: published.publishedVersion!,
      action: {
        type: "check",
        blockId: "tasks",
        itemId: "proof",
        checked: true,
      },
    }
    const deadline = await this.appRunner.armDiscovery()
    this.db.run(
      "UPDATE apps_probe SET deadline=?,input=?",
      deadline,
      JSON.stringify(input)
    )
    // Execute the actual Lifecycle queue while the interaction does not exist.
    await this.lifecycle.alarm()
  }
  private async appsSnapshot() {
    const state = this.probe()
    const input = state.input ? (JSON.parse(state.input) as InteractApp) : null
    return {
      ...this.snapshot(),
      app: {
        ...state,
        input,
        jobs: this.appRunner.jobs(),
        events: this.db
          .all<{ record: string; queued: number }>(
            "SELECT record,queued FROM generated_app_events ORDER BY sequence"
          )
          .map((row) => ({
            ...row,
            record: JSON.parse(row.record) as unknown,
          })),
        receipts: input
          ? this.db.all(
              "SELECT * FROM generated_app_operations WHERE id=?",
              input.operationId
            )
          : [],
        documents: this.db
          .all<{ record: string }>("SELECT record FROM generated_apps")
          .map((row) => JSON.parse(row.record) as unknown),
      },
      physicalAlarm: await this.ctx.storage.getAlarm(),
    }
  }
  override async fetch(request: Request) {
    const action = new URL(request.url).pathname.split("/").at(-1)
    // A raw status cannot activate Pi, reconcile queue absence, or wake Apps.
    if (action === "status") return Response.json(await this.appsSnapshot())
    await this.lifecycle.start()
    if (action === "arm-empty") await this.setup()
    if (action === "commit-lost-wake" || action === "replay") {
      const state = this.probe()
      await Effect.runPromise(
        this.apps.interact(
          JSON.parse(state.input!) as InteractApp,
          undefined,
          state.deadline!
        )
      )
      // Deliberately omit the postcommit Apps doorbell.
    }
    if (action === "exhaust") {
      this.db.run("UPDATE apps_probe SET fail_scan=1")
      await this.appRunner.wake()
      await this.lifecycle.alarm()
    }
    if (action === "wake") {
      await this.appRunner.wake()
      await this.lifecycle.alarm()
    }
    return Response.json(await this.appsSnapshot())
  }
}

export default {
  async fetch(
    request: Request,
    env: { APPS: DurableObjectNamespace<AppsProbe> }
  ) {
    const [name] = new URL(request.url).pathname.split("/").filter(Boolean)
    if (name === "health") return Response.json({ ready: true })
    return env.APPS.get(env.APPS.idFromName(name ?? "default")).fetch(request)
  },
}
