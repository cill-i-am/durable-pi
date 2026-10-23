import { Cause, Clock, Deferred, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"

import { homeAgentId } from "../src/agents/domain"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { EmailStore } from "../src/email/adapters/sqlite"
import { EmailRejected, EmailUnavailable } from "../src/email/contracts"
import { emailPump, type EmailPumpHost } from "../src/email/pump"
import { ReplySendFailed } from "../src/replies/contracts"
import { WhatsAppStore } from "../src/whatsapp/adapters/sqlite"
import {
  WhatsAppRejected,
  WhatsAppUnavailable,
} from "../src/whatsapp/contracts"
import { whatsappPump, type WhatsAppPumpHost } from "../src/whatsapp/pump"
import { database } from "./database"
import { imageMetadata } from "./image-fixture"
import { fixtureClock } from "./routine-fixture"

async function fixture(
  channel: "email" | "whatsapp",
  body = "Help with dinner."
) {
  const db = database(),
    email = new EmailStore(db),
    whatsapp = new WhatsAppStore(db)
  const conversations = new ConversationStore(db, {
    model: "test",
    thinking: "medium",
  })
  const now = Date.now(),
    id = crypto.randomUUID()
  const liveClock = Effect.runSync(Clock.Clock)
  const clock = {
    ...fixtureClock(() => now),
    sleep: (duration: Parameters<Clock.Clock["sleep"]>[0]) =>
      liveClock.sleep(duration),
  }
  const run = <A>(work: Effect.Effect<A, unknown>) =>
    Effect.runPromise(work.pipe(Effect.provideService(Clock.Clock, clock)))
  const faults = {
    stage: "",
    rejected: false,
    compound: false,
    uncertain: false,
  }
  const state: { observation: "missing" | "running" | "approval" | "done" } = {
    observation: "done",
  }
  const sent: string[] = [],
    admitted: string[] = []
  const work = <A, E>(stage: string, success: Effect.Effect<A>, error: E) =>
    Effect.suspend(() => {
      if (faults.stage !== stage) return success
      return faults.compound
        ? Effect.failCause(
            Cause.fromReasons([
              Cause.makeFailReason(error),
              Cause.makeDieReason("failed native cleanup"),
            ])
          )
        : Effect.fail(error)
    })
  const emailWork = <A>(stage: string, success: Effect.Effect<A>) =>
    work(stage, success, new EmailUnavailable())
  const whatsappWork = <A>(stage: string, success: Effect.Effect<A>) =>
    Effect.suspend(() =>
      work(
        stage,
        success,
        faults.rejected
          ? new WhatsAppRejected({ message: "Native request rejected" })
          : new WhatsAppUnavailable()
      )
    )
  const admit = (operation: Parameters<EmailPumpHost["admit"]>[0]) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        conversations.admit(operation, undefined, [], undefined, {
          discoveryDeadline: now + 60_000,
        })
      ),
      Effect.orDie,
      Effect.tap(() =>
        Effect.sync(() => {
          admitted.push(operation.operationId)
        })
      )
    )
  const turn = () =>
    Effect.gen(function* () {
      const current = yield* conversations.get(id).pipe(Effect.orDie)
      return state.observation === "missing" || !current
        ? undefined
        : {
            ...current,
            status:
              state.observation === "done"
                ? ("done" as const)
                : ("running" as const),
            answer: state.observation === "done" ? "Dinner is ready." : "",
          }
    })
  const send = (text: string) =>
    Effect.suspend(() => {
      sent.push(text)
      return faults.uncertain
        ? Effect.fail(new ReplySendFailed({ uncertain: true }))
        : Effect.succeed(`provider-${sent.length}`)
    })
  const emailHost: EmailPumpHost = {
    armReply: () => emailWork("arm", Effect.void),
    active: () => emailWork("active", Effect.succeed(true)),
    control: () => emailWork("control", Effect.succeed("Task status.")),
    admit: (input) => emailWork("admit", admit(input)),
    turn: () => emailWork("observe", turn()),
    reviewUrl: () =>
      emailWork("review", Effect.succeed("https://pi.example.com/agents/home")),
    files: () => emailWork("files", Effect.succeed([])),
    notices: () => emailWork("notify", Effect.succeed([])),
    send: (_record, text) => send(text),
  }
  const whatsappHost: WhatsAppPumpHost = {
    armReply: () => whatsappWork("arm", Effect.void),
    active: () => whatsappWork("active", Effect.succeed(true)),
    control: () => whatsappWork("control", Effect.succeed("Task status.")),
    media: () => whatsappWork("media", Effect.succeed(crypto.randomUUID())),
    admit: (_agent, input) => whatsappWork("admit", admit(input)),
    turn: () =>
      whatsappWork(
        "observe",
        turn().pipe(
          Effect.map((current) =>
            current
              ? {
                  status: current.status,
                  answer: current.answer,
                  needsApproval: state.observation === "approval",
                }
              : undefined
          )
        )
      ),
    name: () => whatsappWork("name", Effect.succeed("Home")),
    reviewUrl: () => "https://pi.example.com/agents/home",
    send: (_record, text) => send(text),
  }
  const common = { id, fingerprint: "a".repeat(64), body }
  if (channel === "email")
    await run(
      email.receive(
        {
          ...common,
          messageId: "<pump@example.com>",
          sender: "owner@example.com",
          recipient: "private@example.com",
          subject: "Pump",
          references: "",
        },
        1,
        now + 60_000
      )
    )
  else {
    await run(
      whatsapp.configure(
        { operationId: crypto.randomUUID(), enabled: true, revision: 0 },
        homeAgentId
      )
    )
    await run(
      whatsapp.receive(
        {
          ...common,
          messageId: "wamid.pump",
          sender: "15550101010",
          threadId: "whatsapp:123456:15550101010",
          timestamp: now,
        },
        homeAgentId,
        {},
        now + 60_000
      )
    )
  }
  const pump =
    channel === "email"
      ? emailPump(email, emailHost)
      : whatsappPump(whatsapp, whatsappHost)
  const get = () =>
    channel === "email" ? run(email.get(id)) : run(whatsapp.get(id))
  return {
    db,
    email,
    whatsapp,
    emailHost,
    whatsappHost,
    now,
    id,
    run,
    pump,
    get,
    faults,
    state,
    sent,
    admitted,
  }
}

describe.each(["email", "whatsapp"] as const)(
  "%s pump failure accounting",
  (channel) => {
    const stages =
      channel === "email"
        ? [
            "active",
            "admit",
            "control",
            "observe",
            "review",
            "files",
            "arm",
            "notify",
          ]
        : ["active", "admit", "control", "observe", "name", "arm", "media"]
    it.each(stages)(
      "propagates %s failures for durable retry accounting without an external send",
      async (stage) => {
        const f = await fixture(
          channel,
          stage === "control" ? "STATUS" : undefined
        )
        if (stage === "media")
          f.db.run(
            "UPDATE whatsapp_messages SET image=? WHERE id=?",
            JSON.stringify(imageMetadata),
            f.id
          )
        if (!["active", "admit", "control", "media"].includes(stage))
          await f.run(f.pump())
        if (stage === "notify") f.state.observation = "approval"
        f.faults.stage = stage
        for (let attempt = 0; attempt < 3; attempt++)
          await expect(f.run(f.pump())).rejects.toMatchObject({
            _tag:
              channel === "email" ? "EmailUnavailable" : "WhatsAppUnavailable",
          })
        expect(f.sent).toEqual([])
        expect((await f.get())?.state).toBe(
          ["active", "admit", "control", "media"].includes(stage)
            ? "queued"
            : "waiting"
        )
        f.faults.stage = ""
        f.state.observation = "done"
        await f.run(f.pump())
        await f.run(f.pump())
        await f.run(f.pump())
        expect((await f.get())?.state).toBe("sent")
        expect(f.sent).toHaveLength(1)
        expect(f.admitted).toEqual(stage === "control" ? [] : [f.id])
      }
    )

    it.each(["missing", "running", "approval"] as const)(
      "keeps a successful %s observation on the normal five-second wake",
      async (observation) => {
        const f = await fixture(channel)
        await f.run(f.pump())
        f.state.observation = observation
        expect(await f.run(f.pump())).toBe(f.now + 5000)
        expect((await f.get())?.state).toBe("waiting")
        expect(f.admitted).toEqual([f.id])
        expect(f.sent).toEqual([])
      }
    )

    it("does not turn a native failure plus cleanup defect into a normal retry or wait", async () => {
      const f = await fixture(channel)
      f.faults.stage = "admit"
      f.faults.compound = true
      const exit = await f.run(
        Effect.exit<number | undefined, unknown, never>(f.pump())
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("Expected native failure")
      expect(Cause.hasDies(exit.cause)).toBe(true)
      expect(exit.cause.reasons).toHaveLength(2)
      expect(f.sent).toEqual([])
      expect((await f.get())?.state).toBe("queued")
    })

    it("does not resend an uncertain provider part during later successful pump attempts", async () => {
      const f = await fixture(channel)
      await f.run(f.pump())
      f.faults.uncertain = true
      await f.run(f.pump())
      expect((await f.get())?.state).toBe("uncertain")
      for (let attempt = 0; attempt < 3; attempt++) await f.run(f.pump())
      expect(f.sent).toHaveLength(1)
    })
  }
)

describe("local semantic reply rejection", () => {
  it.each(["active", "admit", "control", "observe", "name", "arm"])(
    "propagates WhatsApp %s rejection outside the explicit semantic catches",
    async (stage) => {
      const f = await fixture(
        "whatsapp",
        stage === "control" ? "STATUS" : undefined
      )
      if (!["active", "admit", "control"].includes(stage)) await f.run(f.pump())
      f.faults.stage = stage
      f.faults.rejected = true
      await expect(f.run(f.pump())).rejects.toMatchObject({
        _tag: "WhatsAppRejected",
      })
      expect(f.sent).toEqual([])
    }
  )

  it("keeps an email approval rejection as a response message", async () => {
    const f = await fixture("email", "APPROVE invalid")
    f.emailHost.decide = () =>
      Effect.fail(new EmailRejected({ message: "This approval expired." }))
    expect(await f.run(f.pump())).toBe(f.now + 5000)
    expect((await f.get())?.reply).toBe("This approval expired.")
    await f.run(f.pump())
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]).toContain("This approval expired.")
    expect(f.admitted).toEqual([])
  })

  it("records invalid WhatsApp media without inference or a transport retry", async () => {
    const f = await fixture("whatsapp")
    f.db.run(
      "UPDATE whatsapp_messages SET image=? WHERE id=?",
      JSON.stringify(imageMetadata),
      f.id
    )
    f.faults.stage = "media"
    f.faults.rejected = true
    await f.run(f.pump())
    expect(await f.get()).toMatchObject({
      state: "failed",
      error: "Native request rejected",
    })
    expect(f.sent).toEqual([])
    expect(f.admitted).toEqual([])
  })

  it("keeps an unavailable approval notice recipient as a normal waiting turn", async () => {
    const f = await fixture("whatsapp")
    await f.run(f.pump())
    f.state.observation = "approval"
    f.whatsapp.notice = () =>
      Effect.fail(
        new WhatsAppRejected({ message: "The notice recipient changed." })
      )
    expect(await f.run(f.pump())).toBe(f.now + 5000)
    expect((await f.get())?.state).toBe("waiting")
    expect(f.sent).toEqual([])
    expect(f.admitted).toEqual([f.id])
  })
})

describe("reply preparation ownership boundaries", () => {
  it.each(["email", "whatsapp"] as const)(
    "uses the current %s record after a held enumeration/read boundary",
    async (channel) => {
      const f = await fixture(channel, "STATUS")
      const entered = Deferred.makeUnsafe<void>(),
        release = Deferred.makeUnsafe<void>()
      let first = true,
        controls = 0
      const hold = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.suspend(() => {
          if (!first) return effect
          first = false
          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(effect)
          )
        })
      if (channel === "email") {
        const read = f.email.getPendingWork.bind(f.email)
        f.email.getPendingWork = (id) => hold(read(id))
        f.emailHost.control = () =>
          Effect.sync(() => {
            controls++
            return "Repeated control"
          })
      } else {
        const read = f.whatsapp.getPendingWork.bind(f.whatsapp)
        f.whatsapp.getPendingWork = (id) => hold(read(id))
        f.whatsappHost.control = () =>
          Effect.sync(() => {
            controls++
            return "Repeated control"
          })
      }
      const pumping = f.run(f.pump())
      await f.run(Deferred.await(entered))
      if (channel === "email")
        await f.run(f.email.prepared(f.id, "Previously committed control"))
      else
        await f.run(
          f.whatsapp.prepared(f.id, "Previously committed control", true)
        )
      await f.run(Deferred.succeed(release, undefined))
      await pumping
      expect(controls).toBe(0)
      expect(f.sent).toHaveLength(1)
      expect(f.sent[0]).toContain("Previously committed control")
      expect((await f.get())?.state).toBe("sent")
    }
  )

  it.each(["review", "files", "name"] as const)(
    "bounds the concrete %s host before any provider dispatch",
    async (stage) => {
      const channel = stage === "name" ? "whatsapp" : "email"
      const f = await fixture(channel)
      await f.run(f.pump())
      f.db.run(
        `UPDATE ${channel}_messages SET work_deadline=? WHERE id=?`,
        f.now + 25,
        f.id
      )
      if (stage === "review") f.emailHost.reviewUrl = () => Effect.never
      else if (stage === "files") f.emailHost.files = () => Effect.never
      else f.whatsappHost.name = () => Effect.never
      await expect(f.run(f.pump())).rejects.toMatchObject({
        _tag: channel === "email" ? "EmailUnavailable" : "WhatsAppUnavailable",
      })
      expect(f.sent).toEqual([])
      expect((await f.get())?.state).toBe("waiting")
      expect(
        f.db.all<{ work_deadline: number }>(
          `SELECT work_deadline FROM ${channel}_messages WHERE id=?`,
          f.id
        )[0]!.work_deadline
      ).toBe(f.now + 25)
    }
  )

  it.each(["authority lookup", "expiry commit"] as const)(
    "keeps a WhatsApp window reopened during a held %s",
    async (held) => {
      const f = await fixture("whatsapp")
      f.db.run(
        "UPDATE whatsapp_settings SET last_inbound_at=?",
        f.now - 24 * 60 * 60 * 1000 - 1000
      )
      const entered = Deferred.makeUnsafe<void>(),
        release = Deferred.makeUnsafe<void>()
      const hold = <A, E>(effect: Effect.Effect<A, E>) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(effect)
        )
      if (held === "authority lookup")
        f.whatsappHost.active = () => hold(Effect.succeed(true))
      else {
        const expire = f.whatsapp.expire.bind(f.whatsapp)
        f.whatsapp.expire = (id, error, revision) =>
          hold(expire(id, error, revision))
      }
      const pumping = f.run(f.pump())
      await f.run(Deferred.await(entered))
      const fresh = crypto.randomUUID()
      await f.run(
        f.whatsapp.receive(
          {
            id: fresh,
            fingerprint: "b".repeat(64),
            messageId: "wamid.new-window",
            sender: "15550101010",
            threadId: "whatsapp:123456:15550101010",
            timestamp: f.now,
            body: "The reply window is open.",
          },
          homeAgentId,
          {},
          f.now + 60_000
        )
      )
      await f.run(Deferred.succeed(release, undefined))
      await pumping
      expect((await f.get())?.state).toBe(
        held === "authority lookup" ? "waiting" : "queued"
      )
      expect(f.sent).toEqual([])
      expect((await f.run(f.whatsapp.settings())).lastInboundAt).toBe(f.now)
    }
  )
})
