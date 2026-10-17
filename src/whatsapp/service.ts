import { Effect, Schema } from "effect"

import { AgentId, type AgentProfile } from "../agents/domain"
import { preserveFatal } from "../shared/effect"
import type { WhatsAppStore } from "./adapters/sqlite"
import {
  WhatsAppRejected,
  WhatsAppUnavailable,
  type ConfigureWhatsApp,
  type IncomingWhatsApp,
  type WhatsAppFailure,
} from "./contracts"
import { whatsappPump, type WhatsAppPumpHost } from "./pump"

export interface WhatsAppHost extends WhatsAppPumpHost {
  profiles: () => Effect.Effect<readonly AgentProfile[], WhatsAppFailure>
  configured: () => boolean
  contactUrl: () => string | null
  wake: () => Effect.Effect<unknown, WhatsAppFailure>
}
export function whatsappApplication(store: WhatsAppStore, host: WhatsAppHost) {
  const configure = (input: ConfigureWhatsApp, id: AgentId) =>
    Effect.gen(function* () {
      if (input.enabled && (!host.configured() || !(yield* host.active(id))))
        return yield* new WhatsAppUnavailable()
      yield* store.configure(input, id)
    })
  const receive = (input: IncomingWhatsApp) =>
    Effect.gen(function* () {
      if (!host.configured()) return yield* new WhatsAppUnavailable()
      const previous = yield* store.get(input.id)
      if (previous) {
        if (previous.fingerprint !== input.fingerprint)
          return yield* new WhatsAppRejected({
            message: "This WhatsApp message ID belongs to different content.",
          })
        // Admission may have committed before wake acknowledgement was lost.
        yield* host.wake()
        return false
      }
      const settings = yield* store.settings()
      if (!settings.enabled) return false
      const command = input.media ? "" : input.body.trim()
      let route: AgentId | undefined
      let reply = ""
      if (command === "/agents") {
        const agents = (yield* host.profiles()).filter(
          (agent) => agent.status === "active"
        )
        reply = `Choose an agent with /agent <id>:\n${agents.map((agent) => `${agent.name}: ${agent.id}`).join("\n")}`
      } else if (command.startsWith("/agent ")) {
        const id = Schema.decodeUnknownOption(AgentId)(command.slice(7).trim())
        if (id._tag === "Some" && (yield* host.active(id.value))) {
          route = id.value
          reply = `New messages will go to ${yield* host.name(route)}. Earlier requests keep their original agent.`
        } else
          reply =
            "That agent is unavailable. Send /agents to see your active agents."
      }
      const accepted = yield* store.receive(input, route ?? settings.agentId, {
        reply,
        route,
      })
      yield* host.wake()
      return accepted
    })
  const view = () =>
    Effect.gen(function* () {
      const settings = yield* store.settings()
      const profiles = yield* host.profiles()
      return {
        configured: host.configured(),
        enabled: settings.enabled,
        revision: settings.revision,
        agentId: settings.agentId,
        agentName:
          profiles.find((agent) => agent.id === settings.agentId)?.name ??
          settings.agentId,
        contactUrl: host.contactUrl(),
        messages: (yield* store.list()).map(
          ({
            id,
            agentId,
            state,
            error,
            createdAt,
            media,
            outboundFileId,
          }) => ({
            id,
            agentId,
            state,
            error,
            createdAt,
            kind: media
              ? media.mime.startsWith("audio/")
                ? ("audio" as const)
                : ("image" as const)
              : outboundFileId
                ? ("media" as const)
                : ("text" as const),
          })
        ),
      }
    })
  return { configure, receive, view, pump: whatsappPump(store, host) }
}

export function whatsappResponse<T>(
  work: Effect.Effect<T, WhatsAppFailure | Schema.SchemaError>
) {
  return work.pipe(
    preserveFatal,
    Effect.catchTags({
      WhatsAppRejected: (error) =>
        Effect.succeed(
          Response.json({ error: error.message }, { status: 409 })
        ),
      WhatsAppUnavailable: () =>
        Effect.succeed(
          Response.json(
            {
              error:
                "WhatsApp is not configured or is temporarily unavailable.",
            },
            { status: 503 }
          )
        ),
      WhatsAppStorageError: () =>
        Effect.succeed(
          Response.json(
            {
              error:
                "WhatsApp storage is temporarily unavailable. Retry the same request.",
            },
            { status: 503 }
          )
        ),
      SchemaError: () =>
        Effect.succeed(
          Response.json({ error: "Invalid WhatsApp request." }, { status: 400 })
        ),
    })
  )
}
