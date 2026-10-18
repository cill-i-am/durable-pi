import { Effect, Exit, Scope } from "effect"

import { homeAgentId } from "../../src/agents/domain"
import { EmailStore } from "../../src/email/adapters/sqlite"
import type { ReplyProgress } from "../../src/replies/contracts"
import { deliverReply } from "../../src/replies/delivery"
import { WhatsAppStore } from "../../src/whatsapp/adapters/sqlite"
import { nativeDatabase } from "./database"

/** Real actor-local ledgers and delivery module, with a fault after provider
 * acceptance but before its second receipt commits. The process then restarts. */
export async function probeReplies(
  storage: DurableObjectStorage,
  phase: number
) {
  const scope = Effect.runSync(Scope.make())
  try {
    const db = nativeDatabase(storage, scope)
    db.run(
      "CREATE TABLE IF NOT EXISTS fixture_reply_sends (channel TEXT, body TEXT)"
    )
    const email = new EmailStore(db),
      whatsapp = new WhatsAppStore(db)
    const id = "77777777-7777-4777-8777-777777777777"
    if (phase === 0) {
      await Effect.runPromise(
        email.receive(
          {
            id,
            fingerprint: "a".repeat(64),
            messageId: "<native@example.com>",
            sender: "owner@example.com",
            recipient: "private@agents.example.com",
            subject: "Native multipart",
            body: "Reply",
            references: "",
          },
          (await Effect.runPromise(email.settings())).generation
        )
      )
      await Effect.runPromise(email.update(id, "queued", "waiting"))
      await Effect.runPromise(
        whatsapp.configure(
          { operationId: crypto.randomUUID(), revision: 0, enabled: true },
          homeAgentId
        )
      )
      await Effect.runPromise(
        whatsapp.receive(
          {
            id,
            fingerprint: "b".repeat(64),
            messageId: "wamid.multipart",
            threadId: "whatsapp:123456:15550101010",
            sender: "15550101010",
            body: "Reply",
            timestamp: Date.now(),
          },
          homeAgentId
        )
      )
      await Effect.runPromise(whatsapp.update(id, "queued", "waiting"))
    }
    const result = []
    for (const channel of ["email", "whatsapp"] as const) {
      const read = (): Effect.Effect<
        { state: string; delivery?: ReplyProgress | null } | undefined
      > =>
        channel === "email"
          ? email.get(id).pipe(Effect.orDie)
          : whatsapp.get(id).pipe(Effect.orDie)
      const initial = await Effect.runPromise(read())
      const whatsappRecord = await Effect.runPromise(
        whatsapp.get(id).pipe(Effect.orDie)
      )
      const update = (
        from: "sending",
        state: "sending" | "sent" | "failed" | "uncertain",
        details: { delivery?: ReplyProgress; providerId?: string | null }
      ) =>
        channel === "email"
          ? email.update(id, from, state, details).pipe(Effect.orDie)
          : whatsapp.update(id, from, state, details).pipe(Effect.orDie)
      const progress: ReplyProgress = initial!.delivery ?? {
        version: 1,
        generation: (
          await Effect.runPromise(
            channel === "email"
              ? email.settings().pipe(Effect.orDie)
              : whatsapp.settings().pipe(Effect.orDie)
          )
        ).generation,
        parts: [
          { text: "confirmed first", files: [] },
          { text: "unconfirmed second", files: [] },
        ],
        receipts: [],
      }
      if (phase === 1) {
        await Effect.runPromise(
          channel === "email"
            ? email.recover().pipe(Effect.orDie)
            : whatsapp.recover().pipe(Effect.orDie)
        )
      } else {
        if (phase === 2)
          await Effect.runPromise(
            channel === "email"
              ? email.retry(id, true, crypto.randomUUID()).pipe(Effect.orDie)
              : whatsapp.retry(id, true, crypto.randomUUID()).pipe(Effect.orDie)
          )
        const exit = await Effect.runPromiseExit(
          deliverReply(progress, {
            claim: (delivery, from) =>
              channel === "email"
                ? email
                    .claim(
                      id,
                      "complete answer",
                      () => Effect.succeed(true),
                      delivery,
                      from
                    )
                    .pipe(Effect.orDie)
                : whatsapp
                    .claim(
                      whatsappRecord!,
                      "complete answer",
                      () => Effect.succeed(true),
                      delivery,
                      from
                    )
                    .pipe(Effect.orDie),
            send: (part) =>
              Effect.sync(() => {
                db.run(
                  "INSERT INTO fixture_reply_sends VALUES (?,?)",
                  channel,
                  part.text
                )
                return `provider-${db.all("SELECT body FROM fixture_reply_sends WHERE channel=?", channel).length}`
              }),
            checkpoint: (delivery) =>
              phase === 0 && delivery.receipts.length === 2
                ? Effect.die(
                    "Synthetic lost checkpoint after provider acceptance"
                  )
                : update("sending", "sending", { delivery }),
            finish: (state, providerId) =>
              update("sending", state, { providerId }),
          })
        )
        if (phase === 0 && !Exit.isFailure(exit))
          throw new Error("Checkpoint fault did not run")
        if (phase === 2 && Exit.isFailure(exit))
          throw new Error("Explicit retry failed")
      }
      const current = await Effect.runPromise(read())
      result.push({
        channel,
        state: current!.state,
        receipts: current!.delivery!.receipts,
        sends: db
          .all<{ body: string }>(
            "SELECT body FROM fixture_reply_sends WHERE channel=? ORDER BY rowid",
            channel
          )
          .map((row) => row.body),
      })
    }
    return result
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
}
