import { Effect, Exit, Schema } from "effect"

import { preserveFatal } from "../shared/effect"
import type { CoordinationStore } from "./adapters/sqlite"
import { admitCoordination } from "./admission"
import {
  CoordinationFailure,
  SendMessage,
  agentActor,
  canContact,
  fail,
  sameAgent,
  type Address,
  type Agent,
  type AgentReply,
  type Message,
} from "./contracts"

type Work<T> = Effect.Effect<T, CoordinationFailure>
export interface CoordinationHost {
  bot: string
  source: (nativeId: number) => Work<Agent | undefined>
  agents: (sessionId: string) => Work<Agent[]>
  sessions: (
    before?: string
  ) => Work<{ id: string; title: string; status: string }[]>
  latest: (agent: Agent) => Work<AgentReply | null>
  deliver: (message: Message, target: Agent, attempt: string) => Work<void>
  prearm: () => Work<number>
  wake: () => Work<void>
  enabled: () => Work<boolean>
}
export class AgentCoordination {
  constructor(
    readonly store: CoordinationStore,
    private readonly host: CoordinationHost,
    private readonly now = Date.now,
    private readonly uuid = () => crypto.randomUUID()
  ) {}
  private requireLive(agent: Agent | undefined): Work<Agent> {
    return Effect.gen({ self: this }, function* () {
      if (!agent)
        return yield* fail(
          "not_found",
          "This agent is not available in this bot."
        )
      if (
        !(yield* this.host.enabled()) ||
        agent.status === "stopped" ||
        (yield* this.store.closed(agent.address.sessionId)) ||
        (agent.deadline !== undefined && agent.deadline <= this.now())
      )
        return yield* fail("closed", "This agent has stopped or expired.")
      return agent
    })
  }
  source(nativeId: number) {
    return this.host
      .source(nativeId)
      .pipe(Effect.flatMap((agent) => this.requireLive(agent)))
  }
  listAgents(nativeId: number) {
    return Effect.gen({ self: this }, function* () {
      const source = yield* this.source(nativeId)
      return {
        self: source.address,
        agents: (yield* this.host.agents(source.address.sessionId)).map(
          ({ nativeId: _, ...agent }) => agent
        ),
      }
    })
  }
  listSessions(nativeId: number, before?: string) {
    return Effect.gen({ self: this }, function* () {
      const source = yield* this.source(nativeId)
      if (source.role !== "main")
        return yield* fail(
          "forbidden",
          "Only a main agent can discover other sessions."
        )
      const sessions = yield* this.host.sessions(before)
      return {
        self: source.address.sessionId,
        scope: "current bot",
        sessions,
        next: sessions.length === 20 ? sessions.at(-1)!.id : null,
      }
    })
  }
  private target(source: Agent, address: Address): Work<Agent> {
    return Effect.gen({ self: this }, function* () {
      if (!canContact(source, address))
        return yield* fail(
          "forbidden",
          "Children can contact only their own session. Cross-session access is between main agents."
        )
      const target = (yield* this.host.agents(address.sessionId)).find(
        (agent) => sameAgent(agent.address, address)
      )
      if (!target)
        return yield* fail(
          "not_found",
          "This agent is not available in this bot."
        )
      return target
    })
  }
  lastMessage(nativeId: number, address: Address) {
    return Effect.gen({ self: this }, function* () {
      const source = yield* this.source(nativeId)
      const target = yield* this.target(source, address)
      return {
        agent: address,
        author: agentActor(this.host.bot, address),
        lastReply: yield* this.host.latest(target),
        lastMessageToYou: yield* this.store.last(address, source.address),
        lastSent: yield* this.store.lastSent(source.address, address),
      }
    })
  }
  send(nativeId: number, operationId: string, raw: SendMessage) {
    return Effect.gen({ self: this }, function* () {
      const source = yield* this.source(nativeId)
      const input = yield* Schema.decodeUnknownEffect(SendMessage)(raw).pipe(
        Effect.mapError(() => fail("invalid", "Invalid agent message."))
      )
      const target = yield* this.requireLive(
        yield* this.target(source, input.to)
      )
      if (sameAgent(source.address, target.address))
        return yield* fail("invalid", "Choose another agent as the recipient.")
      if (!input.text.trim())
        return yield* fail("invalid", "Write a nonempty message.")
      if (input.replyTo) {
        const parent = (yield* this.store.get(input.replyTo))?.message
        if (
          !parent ||
          !sameAgent(parent.from, input.to) ||
          !sameAgent(parent.to, source.address)
        )
          return yield* fail(
            "forbidden",
            "Reply identity must refer to a message between these participants."
          )
      }
      yield* this.source(nativeId)
      const now = this.now()
      const row = yield* admitCoordination({
        arm: this.host.prearm(),
        accept: (deadline) =>
          Effect.gen({ self: this }, function* () {
            const latestSource = yield* this.source(nativeId)
            yield* this.requireLive(yield* this.target(latestSource, input.to))
            return yield* this.store.accept(
              {
                ...input,
                id: this.uuid(),
                operationId,
                from: source.address,
                provenance: {
                  author: agentActor(this.host.bot, source.address),
                  recipients: [agentActor(this.host.bot, target.address)],
                  conversationId: this.host.bot,
                  ...(input.replyTo ? { replyTo: input.replyTo } : {}),
                  causedBy: operationId,
                },
                createdAt: now,
                deadline: Math.min(
                  now + 600000,
                  source.deadline ?? Infinity,
                  target.deadline ?? Infinity
                ),
              },
              deadline,
              this.now
            )
          }),
        wake: this.host.wake(),
      })
      return {
        id: row.message.id,
        status: row.state,
        to: row.message.to,
        error: row.error,
      }
    })
  }
  private deliver(message: Message, attempt: string) {
    return Effect.gen({ self: this }, function* () {
      const source = yield* this.requireLive(
        (yield* this.host.agents(message.from.sessionId)).find((agent) =>
          sameAgent(agent.address, message.from)
        )
      )
      const target = yield* this.requireLive(
        yield* this.target(source, message.to)
      )
      yield* this.host.deliver(message, target, attempt)
      yield* this.store.delivered(message.id, attempt)
    }).pipe(
      preserveFatal,
      Effect.catchTag("CoordinationFailure", (cause) =>
        cause.code === "busy" || cause.code === "unavailable"
          ? this.store.retry(message.id, attempt, this.now())
          : this.store.failed(message.id, attempt, cause.message)
      ),
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? this.store.retry(message.id, attempt, this.now())
          : Effect.void
      )
    )
  }
  pump() {
    return Effect.gen({ self: this }, function* () {
      for (const row of yield* this.store.pending(this.now())) {
        const claimed = yield* this.store.claim(
          row.id,
          row.revision,
          this.now(),
          this.uuid()
        )
        if (claimed?.phase === "dispatching" && claimed.attempt_id)
          yield* this.deliver(claimed.message, claimed.attempt_id)
      }
      return yield* this.store.nextWake()
    })
  }
  restore() {
    return this.store.restore(this.now())
  }
}
