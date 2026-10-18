import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai"
import { Cause, Effect, Exit, Schema } from "effect"

import type { AgentEnv } from "../../alchemy.run"
import { connectionNative, connectionRpc } from "../../src/access/adapters/rpc"
import {
  activityDirectory,
  activityReadRpc,
  activityRpc,
} from "../../src/activity/adapters/rpc"
import {
  ActivitySnapshot,
  ActivityConversation,
} from "../../src/activity/contracts"
import { agentRpc, agentRpcNative } from "../../src/agents/adapters/rpc"
import { homeAgentId } from "../../src/agents/domain"
import { backgroundParentRpc } from "../../src/delegation/adapters/background-parent"
import { backgroundNative } from "../../src/delegation/adapters/interop"
import { DelegationFailure } from "../../src/delegation/contracts"
import { BackgroundGroup } from "../../src/delegation/worker"
import {
  accountNative,
  accountRpc,
  accountConnectionRpc,
} from "../../src/inference/adapters/account-rpc"
import { nativeOperation } from "../../src/shared/interop"
import { skillNative, skillRpc } from "../../src/skills/adapters/rpc"
import { webhookAuthorizationRpc } from "../../src/webhooks/adapters/authorization-rpc"
import type { LegacyAgentProbe } from "./legacy-agent-worker"
import type { PersonalAgentProbe } from "./personal-agent-worker"

/** Actual BackgroundGroup host, Layer, native Pi and SQLite. Only provider
 * responses are synthetic; parent authority travels over real DO RPC. */
export class BackgroundGroupProbe extends BackgroundGroup {
  private readonly parents: DurableObjectNamespace<PersonalAgentProbe>
  private readonly legacy: DurableObjectNamespace<LegacyAgentProbe>
  async ownerRpcOutcomes(parentObject: string) {
    const parent = this.parents.get(this.parents.idFromString(parentObject)),
      outcomes = []
    const definitions = await connectionRpc(parent).resolve([])
    const skills = await skillRpc(parent).resolve([])
    for (const boundary of ["connection", "call", "skill"]) {
      for (const kind of [
        "expected",
        "defect",
        "interrupt",
        "mixed",
        "invalid",
      ]) {
        const reply = () =>
          parent.probeOwnerOutcome(boundary, kind).then((raw) => {
            if (JSON.stringify(raw).includes("Private owner"))
              throw new Error("Owner diagnostics leaked across RPC")
            return raw
          })
        const work: Effect.Effect<unknown, unknown> =
          boundary === "skill"
            ? skillNative(() =>
                skillRpc({ skillVersionsV1: reply }).resolve([])
              )
            : connectionNative<unknown>(() =>
                boundary === "call"
                  ? connectionRpc({ connectionsV1: reply }).call(
                      `mcp_${"a".repeat(40)}`,
                      "{}"
                    )
                  : connectionRpc({ connectionsV1: reply }).resolve([])
              )
        const exit = await Effect.runPromiseExit(work)
        outcomes.push({
          boundary,
          kind,
          reasons: Exit.isFailure(exit)
            ? exit.cause.reasons.map((reason) => reason._tag)
            : [],
        })
      }
    }
    return { definitions, skills, outcomes }
  }
  async activityRpcOutcomes(parentObject: string) {
    const parent = this.parents.get(this.parents.idFromString(parentObject)),
      outcomes = []
    for (const boundary of ["snapshot", "conversation", "webhook"]) {
      for (const kind of [
        "expected",
        "defect",
        "interrupt",
        "mixed",
        "invalid",
      ]) {
        const reply = () =>
          parent.probeActivityOutcome(boundary, kind).then((raw) => {
            if (JSON.stringify(raw).includes("Private read"))
              throw new Error("Read diagnostics leaked over RPC")
            return raw
          })
        const work: Effect.Effect<unknown, unknown> =
          boundary === "webhook"
            ? nativeOperation(
                () =>
                  webhookAuthorizationRpc({
                    webhookAuthorizationV1: reply,
                  }).authorized(
                    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    `rpwh_${"a".repeat(64)}`
                  ),
                (cause, channel) => {
                  if (channel === "failure") return cause
                  throw cause
                }
              )
            : activityRpc<unknown>(
                boundary === "snapshot"
                  ? ActivitySnapshot
                  : Schema.NullOr(ActivityConversation),
                () =>
                  boundary === "snapshot"
                    ? activityReadRpc({ activityV1: reply }).snapshot(
                        { id: homeAgentId, name: "Native probe" },
                        { filter: "all", cursor: null }
                      )
                    : activityReadRpc({ activityV1: reply }).conversation(
                        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                        null
                      ),
                (pending) => this.ctx.waitUntil(pending)
              )
        const exit = await Effect.runPromiseExit(work)
        outcomes.push({
          boundary,
          kind,
          reasons: Exit.isFailure(exit)
            ? exit.cause.reasons.map((reason) => reason._tag)
            : [],
        })
      }
    }
    const directory = activityDirectory(
      "owner",
      {
        agentV1: () => parent.probeAgentOutcome("profiles", "expected"),
        modelConnectionV1: () =>
          parent.probeAgentOutcome("connection", "expected"),
      },
      () => ({}),
      (pending) => this.ctx.waitUntil(pending)
    )
    const directoryFailures = []
    for (const read of [
      () => directory.agents(),
      () => directory.find(homeAgentId),
      () => directory.connected(),
    ]) {
      const exit = await Effect.runPromiseExit<unknown, unknown>(read())
      directoryFailures.push(
        Exit.isFailure(exit)
          ? exit.cause.reasons.map((reason) =>
              reason._tag === "Fail" ? reason.error : reason._tag
            )
          : []
      )
    }
    const previous = this.legacy.getByName("previous-agent")
    return {
      outcomes,
      directoryFailures,
      legacy: {
        snapshot: await activityReadRpc(previous).snapshot(
          { id: homeAgentId, name: "Legacy bot" },
          { filter: "all", cursor: null }
        ),
        conversation: await activityReadRpc(previous).conversation(
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          null
        ),
        authorized: await webhookAuthorizationRpc(previous).authorized(
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          `rpwh_${"a".repeat(64)}`
        ),
      },
    }
  }
  async agentRpcOutcomes(parentObject: string) {
    const parent = this.parents.get(this.parents.idFromString(parentObject)),
      outcomes = []
    for (const boundary of ["profiles", "status", "configure", "connection"]) {
      for (const kind of ["expected", "defect", "interrupt", "mixed"]) {
        const reply = () =>
          parent.probeAgentOutcome(boundary, kind).then((raw) => {
            if (JSON.stringify(raw).includes("Private agent"))
              throw new Error("Agent diagnostics leaked across RPC")
            return raw
          })
        const work: Effect.Effect<unknown, unknown> =
          boundary === "connection"
            ? accountNative(() =>
                accountConnectionRpc({ modelConnectionV1: reply }).connected()
              )
            : boundary === "profiles"
              ? agentRpcNative(() => agentRpc({ agentV1: reply }).profiles())
              : boundary === "status"
                ? agentRpcNative(() => agentRpc({ agentV1: reply }).status())
                : agentRpcNative(() =>
                    agentRpc({ agentV1: reply }).configure("", {
                      slug: "fixture",
                      id: homeAgentId,
                      name: "Fixture",
                      instructions: "",
                      status: "active",
                      revision: 1,
                      createdAt: "2026-10-15T00:00:00Z",
                      updatedAt: "2026-10-15T00:00:00Z",
                    })
                  )
        const exit = await Effect.runPromiseExit(work)
        outcomes.push({
          boundary,
          kind,
          reasons: Exit.isFailure(exit)
            ? exit.cause.reasons.map((reason) => reason._tag)
            : [],
        })
      }
    }
    const previous = this.legacy.getByName("previous-agent"),
      client = agentRpc(previous)
    const contacts = await client.contacts(),
      profile = await client.profile(homeAgentId),
      profiles = await client.profiles(),
      status = await client.status(),
      connected = await accountConnectionRpc(previous).connected()
    if (!profile) throw new Error("Legacy profile missing")
    await client.configure("", profile, "legacy-owner")
    await client.prepare("legacy-owner", homeAgentId)
    return {
      outcomes,
      legacy: {
        contacts,
        profile,
        profiles,
        status,
        connected,
        saved: await previous.inspectCompatibility(),
      },
    }
  }
  async parentRpcOutcomes(parentObject: string) {
    const parent = this.parents.get(this.parents.idFromString(parentObject))
    const outcomes = []
    for (const boundary of ["parent", "account"]) {
      for (const kind of ["expected", "defect", "interrupt", "mixed"]) {
        const work: Effect.Effect<unknown, unknown> =
          boundary === "parent"
            ? backgroundNative(() =>
                backgroundParentRpc({
                  backgroundParentV1: () => parent.probeParentOutcome(kind),
                }).authorized(19)
              )
            : accountNative(() =>
                accountRpc({
                  accountV1: () => parent.probeAccountOutcome(kind),
                }).credential("openai")
              )
        const exit = await Effect.runPromiseExit(work)
        outcomes.push({
          boundary,
          kind,
          reasons: Exit.isFailure(exit)
            ? exit.cause.reasons.map((reason) => reason._tag)
            : [],
        })
      }
    }
    return outcomes
  }
  private failure(kind: string) {
    const error = new DelegationFailure({
      code: "cancelled",
      message: "Fixture stopped",
    })
    const failure =
      kind === "expected"
        ? Effect.fail(error)
        : kind === "defect"
          ? Effect.die(new Error("Private fixture defect"))
          : kind === "interrupt"
            ? Effect.interrupt
            : Effect.failCause(
                Cause.fromReasons([
                  Cause.makeFailReason(error),
                  Cause.makeDieReason(new Error("Private compound defect")),
                  Cause.makeInterruptReason(731),
                ])
              )
    return failure
  }
  async probeFailure(kind: string): Promise<never> {
    return this.runtime.runPromise(this.failure(kind))
  }
  async probeOutcome(kind: string): Promise<Schema.Json> {
    this.group.read = () => this.failure(kind)
    return this.invokeV1(
      kind === "invalid" ? { _tag: "ArbitraryOperation" } : { _tag: "Read" }
    )
  }
  private readonly native = this.models.getProvider("openai")!
  private readonly probe = {
    entered: false,
    aborted: false,
    cleaning: false,
    closed: false,
    disposed: false,
    callbacksAfterClose: 0,
  }
  private releaseProvider?: () => void
  constructor(
    ctx: DurableObjectState,
    env: AgentEnv & {
      PERSONAL: DurableObjectNamespace<PersonalAgentProbe>
      LEGACY: DurableObjectNamespace<LegacyAgentProbe>
    }
  ) {
    super(ctx, { ...env, AGENT: env.PERSONAL })
    this.parents = env.PERSONAL
    this.legacy = env.LEGACY
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS background_probe (id INTEGER PRIMARY KEY,calls INTEGER NOT NULL)"
    )
    const faux = fauxProvider({
      provider: "openai",
      models: [{ id: "gpt-6-luna", contextWindow: 8192, maxTokens: 2048 }],
      tokensPerSecond: 1000000,
    })
    this.models.setProvider(faux.provider)
    faux.setResponses(
      Array.from({ length: 12 }, () => async (_context, options) => {
        if (!options?.sessionId)
          throw new Error("Native background provider identity missing")
        await this.runtime.runPromise(this.group.request(options.sessionId), {
          signal: options.signal,
        })
        return fauxAssistantMessage("Native background child findings")
      })
    )
  }
  holdProvider() {
    const wait = new Promise<void>((resolve) => {
      this.releaseProvider = resolve
    })
    this.models.setProvider(this.native)
    const owned = this.models.streamSimple.bind(this.models)
    this.models.streamSimple = (model, context, options) => {
      if (this.runtime.scope.state._tag === "Closed")
        this.probe.callbacksAfterClose++
      return owned(model, context, {
        ...options,
        fetch: async (_input, request) => {
          this.probe.entered = true
          this.ctx.storage.sql.exec(
            "INSERT INTO background_probe VALUES (1,1) ON CONFLICT(id) DO UPDATE SET calls=calls+1"
          )
          request?.signal?.addEventListener(
            "abort",
            () => {
              this.probe.aborted = true
            },
            { once: true }
          )
          return new Response(
            new ReadableStream<Uint8Array>({
              start: (target) =>
                target.enqueue(
                  new TextEncoder().encode(
                    'data: {"type":"response.created","response":{"id":"native-background-held-response","model":"gpt-6-luna","status":"in_progress"}}\n\n'
                  )
                ),
              cancel: async () => {
                this.probe.cleaning = true
                await wait
                this.probe.closed = true
              },
            }),
            { headers: { "content-type": "text/event-stream" } }
          )
        },
      })
    }
  }

  async disposeHeld() {
    await this.lifecycle.dispose()
    this.probe.disposed = true
  }
  releaseHeld() {
    this.releaseProvider?.()
  }
  inspectHeld() {
    return {
      ...this.probe,
      attempts: this.ctx.storage.sql
        .exec<{ payload: string }>(
          "SELECT payload FROM inference_attempts ORDER BY rowid"
        )
        .toArray()
        .map((row) => JSON.parse(row.payload)),
      runtimeOpen: this.runtime.scope.state._tag !== "Closed",
      calls:
        this.ctx.storage.sql
          .exec<{ calls: number }>(
            "SELECT calls FROM background_probe WHERE id=1"
          )
          .toArray()[0]?.calls ?? 0,
    }
  }
}
