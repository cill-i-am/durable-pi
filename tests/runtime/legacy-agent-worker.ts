import { DurableObject } from "cloudflare:workers"
import { Schema } from "effect"

import {
  AgentId,
  homeAgentId,
  type AgentProfile,
} from "../../src/agents/domain"

/** Deliberately has no modern RPC methods: prove the native missing-method
 * path against an actual object, rather than relying on a plain-object fake. */
export class LegacyAgentProbe extends DurableObject<unknown> {
  async agentProfile(id: string): Promise<AgentProfile> {
    return {
      id: Schema.decodeUnknownSync(AgentId)(id),
      name: "Legacy bot",
      instructions: "Synthetic legacy instructions.",
      status: "active",
      revision: 1,
      createdAt: "2026-10-15T00:00:00Z",
      updatedAt: "2026-10-15T00:00:00Z",
    }
  }
  async agentProfiles(): Promise<AgentProfile[]> {
    return [await this.agentProfile(homeAgentId)]
  }
  async activityAgents() {
    return [{ id: homeAgentId, name: "Legacy bot" }]
  }
  async runtimeStatus() {
    return { state: "ready", turnId: null }
  }
  async modelConnected() {
    return true
  }
  async configureBot(
    owner: string,
    profile: AgentProfile,
    communicationOwner?: string
  ): Promise<void> {
    await this.ctx.storage.put("configuration", {
      owner,
      profile,
      communicationOwner,
    })
  }
  async prepareCommunication(owner: string, id: AgentId): Promise<void> {
    await this.ctx.storage.put("prepared", { owner, id })
  }
  async readActivity() {
    return { entries: [], issues: [] }
  }
  async activityConversation() {
    return null
  }
  async webhookAuthorized() {
    return false
  }
  async inspectCompatibility() {
    return {
      configuration: await this.ctx.storage.get("configuration"),
      prepared: await this.ctx.storage.get("prepared"),
    }
  }
}
