import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai"
import * as SqliteDriver from "@effect/sql-sqlite-do/SqliteClient"
import { getAgentByName } from "agents"
import { Cause, Effect, Exit, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"

import type { AgentEnv } from "../../alchemy.run"
import { ConnectionStorageError } from "../../src/access/connections"
import { activityRequest } from "../../src/activity/adapters/http"
import { activityDirectory } from "../../src/activity/adapters/rpc"
import { ActivityStorageError } from "../../src/activity/records"
import { PersonalAgent } from "../../src/agent/worker"
import {
  AgentStorageError,
  AgentSynchronizationError,
  homeAgentId,
} from "../../src/agents/domain"
import { conversationEvents } from "../../src/conversations/adapters/events"
import { backgroundRemote } from "../../src/delegation/adapters/background-rpc"
import { backgroundNative } from "../../src/delegation/adapters/interop"
import { piDelegationLedger } from "../../src/delegation/adapters/pi"
import { backgroundObjectName } from "../../src/delegation/background"
import { DelegationFailure } from "../../src/delegation/contracts"
import { parseEmail } from "../../src/email/adapters/incoming"
import { EmailView } from "../../src/email/contracts"
import { executionWorkerRequest } from "../../src/execution/worker"
import {
  ChatGPTSignIn,
  chatGPTSignInRequest,
} from "../../src/inference/adapters/chatgpt-sign-in"
import {
  toNativeCredential,
  accountCredentials,
} from "../../src/inference/adapters/credentials-pi"
import { createAgentModels } from "../../src/inference/adapters/models-pi"
import { PiModelStreams } from "../../src/inference/adapters/streams-pi"
import {
  OAuthCredential,
  CredentialRefreshError,
  CredentialStorageError,
  type CredentialRefresh,
} from "../../src/inference/credentials"
import { CredentialUnavailable } from "../../src/inference/credentials"
import type { ModelCatalog } from "../../src/inference/policy"
import { resolveRoute } from "../../src/inference/policy"
import { exportResponse } from "../../src/memory/adapters/http"
import { piSummaryCompletion } from "../../src/memory/adapters/pi"
import { pumpSummaries } from "../../src/memory/compaction"
import { MemoryRepository } from "../../src/memory/repository"
import type { SummaryProvider } from "../../src/memory/summary-execution"
import { piObjectLedger } from "../../src/objects/adapters/pi"
import { WorkerTelemetry } from "../../src/observability/worker"
import { piPlanLedger } from "../../src/planning/adapters/pi"
import type { PlanUpdate } from "../../src/planning/contracts"
import { nativeOperation } from "../../src/shared/interop"
import { SkillStorageError } from "../../src/skills/contracts"
import { localTaskControls } from "../../src/tasks/adapters/personal-agent"
import { WebhookStorageError } from "../../src/webhooks/persistence"
import { whatsappRpc } from "../../src/whatsapp/adapters/rpc"
import { whatsappIdentity } from "../../src/whatsapp/contracts"
import { transcript } from "../audio-fixture"
import type { BackgroundGroupProbe } from "./background-worker"
import type { TerminalProbe } from "./terminal-worker"
import type { WhatsAppSink } from "./whatsapp-sink-worker"

class NativeCommitRefused extends Schema.TaggedError<NativeCommitRefused>()(
  "NativeCommitRefused",
  {}
) {}

interface ProbeEnv {
  WHATSAPP: DurableObjectNamespace<WhatsAppSink>
  LOADER: WorkerLoader
  PERSONAL: DurableObjectNamespace<PersonalAgentProbe>
  BACKGROUND: DurableObjectNamespace<BackgroundGroupProbe>
  TERMINALS: DurableObjectNamespace<TerminalProbe>
}

/** Full production actor/Layer/Lifecycle code. Only its external bindings and
 * model are synthetic; native SQL, Pi, alarms and disposal execute in workerd. */
export class PersonalAgentProbe extends PersonalAgent {
  private readonly providerProbe = {
    entered: false,
    aborted: false,
    cleaning: false,
    closed: false,
    settled: false,
    interrupted: false,
    release: undefined as (() => void) | undefined,
  }
  private readonly credentialProbe = {
    calls: 0,
    entered: false,
    aborted: false,
    settled: false,
    interrupted: false,
    wait: undefined as Promise<void> | undefined,
    release: undefined as (() => void) | undefined,
  }
  protected override createCredentialRefresher(): CredentialRefresh {
    return (current) =>
      nativeOperation(
        async (signal) => {
          this.credentialProbe.calls++
          this.credentialProbe.entered = true
          this.fixtureRun(
            "INSERT INTO personal_probe_credential VALUES (1,1) ON CONFLICT(id) DO UPDATE SET attempts=attempts+1"
          )
          const abort = () => {
            this.credentialProbe.aborted = true
          }
          signal.addEventListener("abort", abort, { once: true })
          try {
            await this.credentialProbe.wait
            return Schema.decodeUnknownSync(OAuthCredential)({
              ...toNativeCredential(current),
              access: "native-rotated-access",
              refresh: "native-rotated-refresh",
              expires: Date.now() + 900_000,
            })
          } finally {
            signal.removeEventListener("abort", abort)
            this.credentialProbe.settled = true
          }
        },
        () =>
          new CredentialRefreshError({
            reason: "unavailable",
            message: "Synthetic refresh failed",
          })
      )
  }
  private externalCalls: { count: number }
  private codeProbe: {
    calls: number
    entered: boolean
    aborted: boolean
    settled: boolean
    wait?: Promise<void>
    release?: () => void
  }
  private terminalProbe: { projections: unknown[]; released: number }
  private terminalNamespace: DurableObjectNamespace<TerminalProbe>
  private backgroundNamespace: DurableObjectNamespace<BackgroundGroupProbe>
  private whatsappNamespace: DurableObjectNamespace<WhatsAppSink>
  private fileReply: (id: string, tool?: string) => void
  private voiceReply: () => void
  private commandProbe: {
    entered: boolean
    aborted: boolean
    wait?: Promise<void>
    release?: () => void
  }
  private readonly events: string[] = []
  private releaseStop?: () => void
  private stopEntered = false
  private observationInterrupted = false
  private watchAttached = false
  private readonly maintenanceBackupProbe: {
    held: boolean
    entered: boolean
    release?: () => void
  }
  private summaryGate?: Promise<void>
  private releaseSummary?: () => void
  private summaryEntered = false
  private summaryAborted = false
  private summaryInterrupted = false
  private releaseExport?: () => void
  private exportEntered = false
  private exportCleanupEntered = false
  private exportInterrupted = false
  private downloadProbe: {
    enabled: boolean
    entered: boolean
    cleaning: boolean
    closed: boolean
    interrupted: boolean
    wait?: Promise<void>
    release?: () => void
  }

  constructor(ctx: DurableObjectState, env: ProbeEnv) {
    const calls = { count: 0 }
    const code: PersonalAgentProbe["codeProbe"] = {
      calls: 0,
      entered: false,
      aborted: false,
      settled: false,
    }
    const terminal = { projections: [] as unknown[], released: 0 }
    const command: PersonalAgentProbe["commandProbe"] = {
      entered: false,
      aborted: false,
    }
    const download: PersonalAgentProbe["downloadProbe"] = {
      enabled: false,
      entered: false,
      cleaning: false,
      closed: false,
      interrupted: false,
    }
    const unexpected = async () => {
      calls.count++
      throw new Error("Unexpected external fixture call")
    }
    const objects = new Map<
      string,
      { etag: string; value: string | Uint8Array }
    >()
    const maintenanceBackup: PersonalAgentProbe["maintenanceBackupProbe"] = {
      held: false,
      entered: false,
    }
    const bucket = {
      get: async (key: string) => {
        const object = objects.get(key)
        if (!object) return null
        const bytes =
          typeof object.value === "string"
            ? new TextEncoder().encode(object.value)
            : object.value
        return {
          etag: object.etag,
          text: async () => new TextDecoder().decode(bytes),
          arrayBuffer: async () => bytes.slice().buffer,
          body:
            download.enabled &&
            key.includes("/00000000-0000-4000-8000-000000000014/")
              ? new ReadableStream<Uint8Array>(
                  {
                    pull(controller) {
                      if (!download.entered) {
                        download.entered = true
                        controller.enqueue(bytes)
                        return
                      }
                      return new Promise<void>(() => {})
                    },
                    async cancel() {
                      download.cleaning = true
                      await download.wait
                      download.closed = true
                    },
                  },
                  { highWaterMark: 0 }
                )
              : new ReadableStream({
                  start(controller) {
                    controller.enqueue(bytes)
                    controller.close()
                  },
                }),
        }
      },
      put: async (
        key: string,
        value: string | Uint8Array,
        options?: {
          onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }
        }
      ) => {
        if (maintenanceBackup.held && key.startsWith("memory/")) {
          maintenanceBackup.entered = true
          await new Promise<void>((resolve) => {
            maintenanceBackup.release = resolve
          })
        }
        const current = objects.get(key)
        if (
          options?.onlyIf?.etagMatches &&
          current?.etag !== options.onlyIf.etagMatches
        )
          return null
        if (options?.onlyIf?.etagDoesNotMatch === "*" && current) return null
        const object = { etag: crypto.randomUUID(), value }
        objects.set(key, object)
        return { etag: object.etag }
      },
    }
    super(ctx, {
      AGENT: env.PERSONAL,
      WHATSAPP: env.WHATSAPP,
      WHATSAPP_ACCESS_TOKEN: "synthetic-token",
      WHATSAPP_APP_SECRET: "synthetic-secret",
      WHATSAPP_VERIFY_TOKEN: "synthetic-verifier",
      WHATSAPP_PHONE_NUMBER_ID: "123456",
      WHATSAPP_OWNER_ID: "15550101010",
      WHATSAPP_BUSINESS_NUMBER: "15550102020",
      MEMORY_BACKUPS: bucket,
      WORKSPACE_ASSETS: bucket,
      AI: {
        run: async (model: string) =>
          model === "@cf/openai/whisper-large-v3-turbo"
            ? {
                text: transcript.text,
                transcription_info: { duration: 0.2, language: "en" },
              }
            : Promise.reject(new Error(`Unexpected AI model: ${model}`)),
      },
      IMAGES: {
        info: async () => ({
          format: "image/jpeg",
          fileSize: 6,
          width: 1,
          height: 1,
        }),
        input: () => ({
          transform: () => ({
            output: async () => ({
              image: () =>
                new Blob([new Uint8Array([255, 216, 255, 224])]).stream(),
            }),
          }),
        }),
      },
      BACKGROUND: env.BACKGROUND,
      DOCUMENT_SERVICE: {
        fetch: async (request: Request) =>
          new URL(request.url).pathname === "/pdf"
            ? Response.json({
                text: "[Page 1]\nNative extracted PDF",
                pages: 1,
                readPages: 1,
                truncated: false,
              })
            : unexpected(),
      },
      EXECUTION_SERVICE: {
        fetch: async (request: Request) => {
          const preview = await request.clone().json<{ code: string }>()
          if (preview.code.startsWith("// native-web-app")) {
            code.calls++
            return executionWorkerRequest(request, env.LOADER)
          }
          const input = await request.json<{ code: string }>()
          code.calls++
          if (input.code === "hold")
            return new Response(
              new ReadableStream<Uint8Array>(
                {
                  pull() {
                    code.entered = true
                  },
                  async cancel() {
                    code.aborted = true
                    await code.wait
                    code.settled = true
                  },
                },
                { highWaterMark: 0 }
              )
            )
          if (input.code === "hold-fetch") {
            code.entered = true
            const abort = () => {
              code.aborted = true
            }
            request.signal.addEventListener("abort", abort, { once: true })
            if (request.signal.aborted) abort()
            try {
              await code.wait
            } finally {
              request.signal.removeEventListener("abort", abort)
              code.settled = true
            }
          }
          return Response.json({
            result: "3",
            logs: "synthetic code",
            error: null,
          })
        },
      },
      TERMINAL_SERVICE: {
        fetch: async (request: Request) => {
          if (new URL(request.url).pathname.endsWith("/video"))
            return Response.json({
              duration: 1,
              frames: [{ at: 0, jpeg: "/9j/AA==" }],
              captions: "",
              captionsTruncated: false,
            })
          const [, identity, ...path] = new URL(request.url).pathname.split("/")
          const target = env.TERMINALS.get(env.TERMINALS.idFromName(identity!))
          if (path[0] === "authority")
            terminal.projections.push(await request.clone().json())
          if (
            path.join("/") === "terminal/run" &&
            JSON.stringify(await request.clone().json()).includes(
              "hold fixture"
            )
          ) {
            command.entered = true
            request.signal.addEventListener(
              "abort",
              () => {
                command.aborted = true
              },
              { once: true }
            )
            await command.wait
          }
          const forwarding = new Request(
            `https://terminal.internal/${path.join("/")}`,
            request
          )
          if (path[0] !== "authority") return target.fetch(forwarding)
          const response = await target.fetch(forwarding)
          if (!response.ok)
            throw new Error(
              `Native terminal authority failed: ${response.status} ${await response.text()}`
            )
          await response.arrayBuffer()
          return new Response(
            new ReadableStream({
              cancel() {
                terminal.released++
              },
            })
          )
        },
      },
      BROWSER: { fetch: unexpected },
      OPENAI_CREDENTIAL: "",
      MODEL_ID: "gpt-6-luna",
      OWNER_EMAIL: "owner@example.com",
      AGENT_EMAIL_DOMAIN: "agents.example.com",
      EMAIL_ADDRESS_SECRET: "synthetic-email-address-secret-32-characters",
      EMAIL_REVIEW_URL: "https://pi.example.com",
      AGENT_EMAIL: {
        send: async (message: EmailMessageBuilder) => {
          ctx.storage.sql.exec(
            "INSERT INTO personal_probe_email_sends (body,attachments) VALUES (?,?)",
            message.text ?? "",
            JSON.stringify(
              (message.attachments ?? []).map((file) => ({
                name: file.filename,
                type: file.type,
                bytes:
                  typeof file.content === "string"
                    ? file.content.length
                    : "byteLength" in file.content
                      ? file.content.byteLength
                      : 0,
              }))
            )
          )
          const held = ctx.storage.sql
            .exec<{ held: number }>(
              "SELECT held FROM personal_probe_email_control WHERE id=1"
            )
            .toArray()[0]?.held
          if (held) return new Promise<EmailSendResult>(() => {})
          return { messageId: "<native-email@example.com>" }
        },
      },
    } as unknown as AgentEnv)
    this.maintenanceBackupProbe = maintenanceBackup
    this.externalCalls = calls
    this.fixtureRun(
      "CREATE TABLE IF NOT EXISTS personal_probe_email_sends (body TEXT NOT NULL,attachments TEXT NOT NULL DEFAULT '[]')"
    )
    this.fixtureRun(
      "CREATE TABLE IF NOT EXISTS personal_probe_email_control (id INTEGER PRIMARY KEY,held INTEGER NOT NULL)"
    )
    this.codeProbe = code
    this.terminalProbe = terminal
    this.terminalNamespace = env.TERMINALS
    this.backgroundNamespace = env.BACKGROUND
    this.whatsappNamespace = env.WHATSAPP
    this.commandProbe = command
    this.downloadProbe = download
    this.fixtureRun(
      "CREATE TABLE IF NOT EXISTS personal_probe (id INTEGER PRIMARY KEY,activations INTEGER NOT NULL)"
    )
    this.fixtureRun(
      "INSERT INTO personal_probe VALUES (1,1) ON CONFLICT(id) DO UPDATE SET activations=activations+1"
    )
    this.fixtureRun(
      "CREATE TABLE IF NOT EXISTS personal_probe_summary_retry (start INTEGER NOT NULL,count INTEGER NOT NULL)"
    )
    this.fixtureRun(
      "CREATE TABLE IF NOT EXISTS personal_probe_credential (id INTEGER PRIMARY KEY,attempts INTEGER NOT NULL)"
    )
    const now = new Date().toISOString()
    this.actorRuntime.runSync(
      this.botConfiguration.configure(
        this.ctx.id.equals(env.PERSONAL.idFromName("gateway-owner"))
          ? ""
          : "personal-owner",
        {
          slug: "native-probe",
          id: homeAgentId,
          name: "Native probe",
          instructions: "Synthetic probe only.",
          status: "active",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        }
      )
    )
    const faux = fauxProvider({
      provider: "openai",
      models: [{ id: "gpt-6-luna", contextWindow: 8192, maxTokens: 2048 }],
      tokensPerSecond: 1000000,
    })
    this.actorRuntime.runSync(
      this.conversations.setJobSetting("conversation", {
        model: "gpt-6-luna",
        thinking: "medium",
      })
    )
    this.models.setProvider(faux.provider)
    faux.setResponses([fauxAssistantMessage("Native actor answer")])
    this.fileReply = (id, tool = "share_image") =>
      faux.setResponses(
        Array.from({ length: 6 }, () => async (context) => {
          const summary = "The media was included in this reply."
          if (
            context.messages.some(
              (message) =>
                message.role === "system" &&
                typeof message.content === "string" &&
                message.content.startsWith(
                  "You are a context summarization assistant."
                )
            )
          )
            return fauxAssistantMessage(summary)
          if (
            JSON.stringify(context.messages).includes(summary) ||
            context.messages.some((message) => message.role === "toolResult")
          )
            return fauxAssistantMessage(
              "Native image answer\n" +
                "Complete report paragraph. ".repeat(240) +
                "END OF FULL REPLY"
            )
          return fauxAssistantMessage(
            fauxToolCall(
              tool,
              { id },
              {
                id: "native-share-image",
              }
            ),
            { stopReason: "toolUse" }
          )
        })
      )
    this.voiceReply = () =>
      faux.setResponses([
        async (context) => {
          if (!JSON.stringify(context.messages).includes(transcript.text))
            throw new Error(
              "The voice request transcript was missing from the agent input."
            )
          return fauxAssistantMessage("Native voice answer")
        },
      ])
    const settle = this.connectionClient.settle.bind(this.connectionClient)
    this.connectionClient.settle = () =>
      Effect.sync(() => {
        this.events.push("actor.connections.close")
      }).pipe(Effect.flatMap(settle))
  }

  /** Native SQL here is fixture instrumentation; application calls use db Effects. */
  private fixtureRun(query: string, ...bindings: (string | number | null)[]) {
    this.ctx.storage.sql.exec(query, ...bindings)
  }

  private fixtureRows<T>(
    query: string,
    ...bindings: (string | number | null)[]
  ): T[] {
    return this.ctx.storage.sql.exec(query, ...bindings).toArray() as T[]
  }

  private runnerHoldEntered = false
  private releaseRunner?: () => void
  private coordinationProbeEnabled = false
  protected override catalogProgram(): Effect.Effect<ModelCatalog> {
    return Effect.succeed({
      models: [
        {
          id: "gpt-6-luna",
          name: "Synthetic",
          thinking: ["off", "medium"],
          input: ["text", "image"],
          tools: true,
          contextWindow: this.coordinationProbeEnabled ? 65536 : 8192,
          unavailable: null,
        },
      ],
      checkedAt: new Date().toISOString(),
      error: null,
      usage: "ChatGPT plan usage",
    })
  }
  async probeParentOutcome(kind: string): Promise<Schema.Json> {
    const authorized = this.background.authorized
    const error = new DelegationFailure({
      code: "cancelled",
      message: "Fixture parent stopped",
    })
    const cause =
      kind === "expected"
        ? Cause.fail(error)
        : kind === "defect"
          ? Cause.die(new Error("Private parent defect"))
          : kind === "interrupt"
            ? Cause.interrupt(731)
            : Cause.fromReasons([
                Cause.makeFailReason(error),
                Cause.makeDieReason(
                  new Error("Private parent compound defect")
                ),
                Cause.makeInterruptReason(731),
              ])
    this.background.authorized = () => Effect.failCause(cause)
    try {
      return await this.backgroundParentV1({ _tag: "Authorized", id: 19 })
    } finally {
      this.background.authorized = authorized
    }
  }
  async probeAccountOutcome(kind: string): Promise<Schema.Json> {
    const resolve = this.credentialService.resolve
    const error = new CredentialUnavailable({
      message: "Fixture connection unavailable",
    })
    const cause =
      kind === "expected"
        ? Cause.fail(error)
        : kind === "defect"
          ? Cause.die(new Error("Private account defect"))
          : kind === "interrupt"
            ? Cause.interrupt(731)
            : Cause.fromReasons([
                Cause.makeFailReason(error),
                Cause.makeDieReason(
                  new Error("Private account compound defect")
                ),
                Cause.makeInterruptReason(731),
              ])
    this.credentialService.resolve = () => Effect.failCause(cause)
    try {
      return await this.accountV1({ _tag: "Credential", provider: "openai" })
    } finally {
      this.credentialService.resolve = resolve
    }
  }
  async probeOwnerOutcome(
    boundary: string,
    kind: string
  ): Promise<Schema.Json> {
    const failure = <TError>(error: TError) =>
      Effect.failCause(
        Cause.fromReasons<TError>(
          kind === "expected"
            ? [Cause.makeFailReason(error)]
            : kind === "defect"
              ? [Cause.makeDieReason(new Error("Private owner defect"))]
              : kind === "interrupt"
                ? [Cause.makeInterruptReason(731)]
                : [
                    Cause.makeFailReason(error),
                    Cause.makeDieReason(
                      new Error("Private owner compound defect")
                    ),
                    Cause.makeInterruptReason(731),
                  ]
        )
      )
    if (boundary === "skill") {
      const resolve = this.skillService.resolve
      this.skillService.resolve = () =>
        failure(
          new SkillStorageError({
            operation: "resolve skills",
            cause: "Private owner skill record",
          })
        )
      try {
        return await this.skillVersionsV1(
          kind === "invalid" ? [{ id: "bad", revision: 1 }] : []
        )
      } finally {
        this.skillService.resolve = resolve
      }
    }
    const resolve = this.connections.resolve,
      call = this.connections.call
    const error = new ConnectionStorageError({
      operation: "read owner tools",
      cause: "Private owner connection record",
    })
    this.connections.resolve = () => failure(error)
    this.connections.call = () => failure(error)
    try {
      return await this.connectionsV1(
        kind === "invalid"
          ? { _tag: "RunAnything" }
          : boundary === "call"
            ? {
                _tag: "Call",
                name: `mcp_${"a".repeat(40)}`,
                argumentsJson: "{}",
              }
            : { _tag: "Resolve", names: [] }
      )
    } finally {
      this.connections.resolve = resolve
      this.connections.call = call
    }
  }
  async probeActivityOutcome(
    boundary: string,
    kind: string
  ): Promise<Schema.Json> {
    const failed = <TError>(error: TError) =>
      Effect.failCause(
        Cause.fromReasons<TError>(
          kind === "expected"
            ? [Cause.makeFailReason(error)]
            : kind === "defect"
              ? [Cause.makeDieReason("Private read defect")]
              : kind === "interrupt"
                ? [Cause.makeInterruptReason(731)]
                : [
                    Cause.makeFailReason(error),
                    Cause.makeDieReason("Private read compound defect"),
                    Cause.makeInterruptReason(731),
                  ]
        )
      )
    const snapshot = this.activity.snapshot,
      conversation = this.activity.conversation,
      authorized = this.webhooks.authorized
    Object.assign(this.activity, {
      snapshot: () =>
        failed(new ActivityStorageError({ cause: "Private read storage" })),
      conversation: () =>
        failed(new ActivityStorageError({ cause: "Private read storage" })),
    })
    this.webhooks.authorized = () =>
      failed(
        new WebhookStorageError({
          operation: "read",
          cause: "Private read webhook",
        })
      )
    try {
      if (boundary === "webhook")
        return await this.webhookAuthorizationV1(
          kind === "invalid"
            ? {}
            : {
                id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                key: `rpwh_${"a".repeat(64)}`,
              }
        )
      return await this.activityV1(
        kind === "invalid"
          ? {}
          : boundary === "snapshot"
            ? {
                _tag: "Snapshot",
                agent: { id: homeAgentId, name: "Native probe" },
                query: { filter: "all", cursor: null },
              }
            : {
                _tag: "Conversation",
                id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                cursor: null,
              }
      )
    } finally {
      Object.assign(this.activity, { snapshot, conversation })
      this.webhooks.authorized = authorized
    }
  }
  async probeAgentOutcome(
    boundary: string,
    kind: string
  ): Promise<Schema.Json> {
    const failure = <TError>(error: TError) =>
      Effect.failCause(
        Cause.fromReasons<TError>(
          kind === "expected"
            ? [Cause.makeFailReason(error)]
            : kind === "defect"
              ? [Cause.makeDieReason(new Error("Private agent defect"))]
              : kind === "interrupt"
                ? [Cause.makeInterruptReason(731)]
                : [
                    Cause.makeFailReason(error),
                    Cause.makeDieReason(
                      new Error("Private agent compound defect")
                    ),
                    Cause.makeInterruptReason(731),
                  ]
        )
      )
    if (boundary === "connection") {
      const read = this.accountConnectedProgram
      this.accountConnectedProgram = () => failure(new CredentialStorageError())
      try {
        return await this.modelConnectionV1()
      } finally {
        this.accountConnectedProgram = read
      }
    }
    const list = this.catalog.list,
      status = this.runtimeStatusProgram,
      configure = this.synchronizeConfiguration
    this.catalog.list = () => failure(new AgentStorageError())
    Object.assign(this, {
      runtimeStatusProgram: () => failure(new AgentStorageError()),
      synchronizeConfiguration: () =>
        failure(
          new AgentSynchronizationError({ operation: "project profile" })
        ),
    })
    try {
      return await this.agentV1(
        boundary === "profiles"
          ? { _tag: "Profiles" }
          : boundary === "status"
            ? { _tag: "Status" }
            : {
                _tag: "Configure",
                owner: "personal-owner",
                profile: {
                  slug: "native-probe",
                  id: homeAgentId,
                  name: "Native probe",
                  instructions: "",
                  status: "active",
                  revision: 1,
                  createdAt: "2026-10-15T00:00:00Z",
                  updatedAt: "2026-10-15T00:00:00Z",
                },
              }
      )
    } finally {
      this.catalog.list = list
      Object.assign(this, {
        runtimeStatusProgram: status,
        synchronizeConfiguration: configure,
      })
    }
  }
  protected override createSummaryProvider(): SummaryProvider {
    return {
      prepare: () =>
        Effect.succeed(
          piSummaryCompletion(async (_messages, signal) => {
            if (this.summaryGate) {
              this.summaryEntered = true
              signal.addEventListener(
                "abort",
                () => {
                  this.summaryAborted = true
                },
                { once: true }
              )
              await this.summaryGate
              this.events.push("native.summary.settled")
            }
            return fauxAssistantMessage("Synthetic memory summary")
          })
        ),
    }
  }
  protected override modelConnectedProgram() {
    return Effect.succeed(true)
  }
  protected override familyStateProgram() {
    // This harness exercises actor transactions with synthetic providers. Live
    // family membership and model authority have their own integration tests.
    return Effect.succeed({
      owner: "personal-owner",
      modelOwner: undefined,
      membershipId: "fixture",
      joinedAt: 1,
    })
  }
  protected override accountConnectedProgram(): Effect.Effect<
    boolean,
    CredentialStorageError
  > {
    return Effect.succeed(true)
  }

  private async holdObservation() {
    this.downloadProbe.enabled = true
    this.downloadProbe.wait = new Promise<void>((resolve) => {
      this.downloadProbe.release = resolve
    })
    const download = await this.authenticatedFetch(
      new Request(
        "https://internal/api/agent/files/00000000-0000-4000-8000-000000000014/content"
      )
    )
    const downloadReader = download.body!.getReader()
    if ((await downloadReader.read()).done)
      throw new Error("Native download did not produce its first chunk")
    this.ctx.waitUntil(
      downloadReader.read().then((next) => {
        if (!next.done)
          throw new Error("Native download published after disposal")
        this.downloadProbe.interrupted = true
        this.events.push("download.body.close")
      })
    )
    const root = (await this.actorRuntime.runPromise(
      this.conversations.get("native-personal-turn")
    ))!
    const session = this.harness.session.bind(this.harness)
    const held = new Promise<void>((resolve) => {
      this.releaseStop = resolve
    })
    this.harness.session = (id) => {
      const handle = session(id)
      const events = handle.events.bind(handle)
      handle.events = async () => {
        const stream = await events()
        return {
          ...stream,
          stop: async () => {
            this.stopEntered = true
            await held
            const result = await stream.stop()
            this.events.push("native.stream.stop")
            return result
          },
        }
      }
      return handle
    }
    const response = conversationEvents(
      {
        snapshot: () => this.snapshotProgram(),
        activeSession: () => Effect.succeed(root.session_id ?? undefined),
        watch: (id) => this.harness.session(id).events(),
        subscribe: () => () => {
          this.events.push("native.unsubscribe")
        },
      },
      new AbortController().signal,
      false,
      (program, options) =>
        this.actorRuntime
          .runPromiseExit(
            program.pipe(Effect.provide(WorkerTelemetry)),
            options
          )
          .then((exit) => {
            this.observationInterrupted =
              Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
            return exit
          })
    )
    const reader = response.body!.getReader()
    const first = await reader.read()
    if (first.done) throw new Error("Native SSE did not produce its snapshot")
    this.watchAttached = true
    this.summaryGate = new Promise<void>((resolve) => {
      this.releaseSummary = resolve
    })
    await this.actorRuntime.runPromise(
      this.memory.append(
        "native-held-summary",
        "user",
        "Synthetic long source ".repeat(40)
      )
    )
    this.ctx.waitUntil(
      this.actorRuntime.runPromiseExit(pumpSummaries()).then((exit) => {
        this.summaryInterrupted =
          Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
      })
    )
    this.ctx.waitUntil(
      reader.read().then((next) => {
        if (!next.done) throw new Error("Native SSE did not close on disposal")
        this.events.push("stream.body.close")
      })
    )
    const exportGate = new Promise<void>((resolve) => {
      this.releaseExport = resolve
    })
    const exported = await this.actorRuntime.runPromise(
      exportResponse(false, {
        run: (program, options) =>
          this.actorRuntime.runPromiseExit(program, options).then((exit) => {
            this.exportInterrupted =
              Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
            return exit
          }),
      }).pipe(
        Effect.provideService(MemoryRepository, {
          ...this.memory,
          archivePage: (...args) =>
            Effect.sync(() => {
              this.exportEntered = true
            }).pipe(
              Effect.andThen(this.memory.archivePage(...args)),
              Effect.ensuring(
                Effect.promise(async () => {
                  this.exportCleanupEntered = true
                  await exportGate
                  this.events.push("native.export.settled")
                })
              )
            ),
        })
      )
    )
    const exportReader = exported.body!.getReader()
    if ((await exportReader.read()).done)
      throw new Error("Native export did not produce its header")
    this.ctx.waitUntil(
      exportReader.read().then((next) => {
        if (!next.done)
          throw new Error("Native export published after disposal")
        this.events.push("export.body.close")
      })
    )
    this.ctx.waitUntil(
      this.communication.runtime.runPromiseExit(
        Effect.never.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              this.events.push("communication.stop")
            })
          )
        )
      )
    )
  }

  private async chatGPTNativeProbe(mode: string | null) {
    const saved = await this.actorRuntime.runPromise(
      this.credentialLedger.read("openai")
    )
    if (!saved)
      await this.actorRuntime.runPromise(
        this.credentialLedger.atomic(() =>
          this.credentialLedger.install(
            "openai",
            Schema.decodeUnknownSync(OAuthCredential)({
              type: "oauth",
              clientId: "native-chatgpt-client",
              access: "native-old-access",
              refresh: "native-old-refresh",
              expires: Date.now() + 3_600_000,
            })
          )
        )
      )
    const signIn = new ChatGPTSignIn(
      this.ctx.storage,
      this.credentialLedger,
      this.credentialService,
      () => Effect.succeed({ owner: "native-admin", membershipId: "native" })
    )
    let status = 200,
      replay = 400
    if (mode !== "inspect") {
      const pending = await this.actorRuntime.runPromise(
        signIn.start("native@example.invalid")
      )
      const authorization = new URL(pending.authorizationUrl)
      const callback = new URL(authorization.searchParams.get("redirect_uri")!)
      callback.searchParams.set(
        "state",
        authorization.searchParams.get("state")!
      )
      callback.searchParams.set(
        "code",
        JSON.stringify({
          nonce: authorization.searchParams.get("nonce"),
          challenge: authorization.searchParams.get("code_challenge"),
          redirect: mode === "redirect",
        })
      )
      const finish = () =>
        this.actorRuntime.runPromise(
          chatGPTSignInRequest(
            signIn,
            new Request("https://native.internal/api/agent/model-account", {
              method: "POST",
              body: JSON.stringify({
                action: "finish",
                id: pending.id,
                address: callback.href,
              }),
            })
          )
        )
      status = (await finish()).status
      replay = (await finish()).status
    }
    const row = await this.actorRuntime.runPromise(
      this.credentialLedger.read("openai")
    )
    return Response.json({
      status,
      replay,
      installed:
        row?.seedCurrent &&
        row.value.type === "oauth" &&
        Redacted.value(row.value.access) === "native-chatgpt-access" &&
        row.value.identity?.subject === "native-chatgpt-owner",
      consumed:
        (await this.actorRuntime.runPromise(signIn.status())).pending === null,
      provider: await (
        await fetch("https://auth.openai.com/native-probe/inspect")
      ).json(),
    })
  }

  private async taskControlProbe(
    _request: Request,
    action: string | undefined
  ): Promise<Response | undefined> {
    if (action !== "task-controls") return undefined
    await this.communication.runtime.runPromise(
      this.communication.repository.bindIdentity({
        owner: "task-controls-owner",
        bot: homeAgentId,
      })
    )
    await this.actorRuntime.runPromise(
      this.conversations.admit(
        {
          operationId: "original-task",
          text: "Original queued task.",
        },
        { pending: true, files: [], content: [] },
        undefined,
        undefined,
        { discoveryDeadline: await this.runner.armDiscovery() }
      )
    )
    await this.actorRuntime.runPromise(
      this.conversations.admit(
        {
          operationId: "newer-task",
          text: "Newer queued task.",
        },
        undefined,
        undefined,
        undefined,
        { discoveryDeadline: await this.runner.armDiscovery() }
      )
    )
    const tasks = localTaskControls(this)
    const before = await this.actorRuntime.runPromise(tasks.list())
    const stopped = await this.actorRuntime.runPromise(
      tasks.stop({ kind: "request", id: "original-task" })
    )
    const replay = await this.actorRuntime.runPromise(
      tasks.stop({ kind: "request", id: "original-task" })
    )
    const newer = await this.actorRuntime.runPromise(
      this.conversations.get("newer-task")
    )
    const original = await this.actorRuntime.runPromise(
      this.conversations.get("original-task")
    )
    return Response.json({
      before,
      stopped,
      replay,
      newerState: newer?.status,
      originalSession: original?.session_id,
    })
  }
  private authenticatedFetch(request: Request) {
    const headers = new Headers(request.headers)
    if (!headers.has("x-owner-id")) headers.set("x-owner-id", "personal-owner")
    return super.fetch(new Request(request, { headers }))
  }
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.endsWith("/chatgpt-native"))
      return this.chatGPTNativeProbe(url.searchParams.get("mode"))
    if (
      url.pathname.startsWith("/whatsapp/") ||
      url.pathname.startsWith("/whatsapp-images/") ||
      url.pathname.startsWith("/whatsapp-audio/")
    )
      return this.whatsappProbe(request)
    if (
      url.pathname.startsWith("/email/") ||
      url.pathname.startsWith("/email-held/")
    )
      return this.emailProbe(request)
    if (url.pathname.startsWith("/api/agent/"))
      return this.authenticatedFetch(request)
    if (url.pathname === "/personal-terminal/setup") {
      await this.actorRuntime.runPromise(
        Effect.gen({ self: this }, function* () {
          const current = yield* this.configurationService.read()
          if (!current)
            throw new Error("Native fixture configuration is missing")
          yield* this.configurationHost.syncTerminal({
            revision: current.revision,
            active: current.status === "active",
          })
        })
      )
      return Response.json({ ok: true })
    }
    if (url.pathname.startsWith("/personal-terminal/"))
      return this.authenticatedFetch(
        new Request(
          `https://internal/api/agent/${url.pathname.slice("/personal-terminal/".length)}${url.search}`,
          request
        )
      )
    const action = new URL(request.url).pathname.split("/").at(-1)
    for (const probe of [
      this.heldRunnerProbe,
      this.coordinationProbe,
      this.taskControlProbe,
      this.nativeCommitProbe,
      this.nativeRpcProbe,
      this.commandsProbe,
      this.backgroundWorkProbe,
      this.delegatedWorkProbe,
      this.providerWorkProbe,
      this.credentialWorkProbe,
      this.workspaceFilesProbe,
      this.structuredWorkProbe,
      this.memoryWorkProbe,
    ]) {
      const response = await probe.call(this, request, action)
      if (response) return response
    }
    if (action === "release") {
      this.releaseStop?.()
      this.releaseSummary?.()
      this.releaseExport?.()
    }
    if (action === "release-download") this.downloadProbe.release?.()
    if (action === "dispose") {
      await this.lifecycle.dispose()
      this.events.push("host.dispose")
    }
    return Response.json({
      provider: {
        entered: this.providerProbe.entered,
        aborted: this.providerProbe.aborted,
        cleaning: this.providerProbe.cleaning,
        closed: this.providerProbe.closed,
        settled: this.providerProbe.settled,
        interrupted: this.providerProbe.interrupted,
        attempt: this.fixtureRows<{ payload: string }>(
          "SELECT payload FROM inference_attempts WHERE json_extract(payload,'$.turnId')='native-held-provider'"
        ).map((row) => JSON.parse(row.payload))[0],
      },
      credential: {
        entered: this.credentialProbe.entered,
        aborted: this.credentialProbe.aborted,
        settled: this.credentialProbe.settled,
        interrupted: this.credentialProbe.interrupted,
        pending: this.fixtureRows("SELECT 1 FROM model_credential_refresh")
          .length,
      },
      code: {
        calls: this.codeProbe.calls,
        entered: this.codeProbe.entered,
        aborted: this.codeProbe.aborted,
        settled: this.codeProbe.settled,
        saved: this.fixtureRows<{ record: string }>(
          "SELECT record FROM code_runs WHERE id='native-held-code'"
        )[0]?.record,
      },
      // This inspection endpoint deliberately runs after the actor runtime closes.
      // Read assertion snapshots through fixture instrumentation, like counters below.
      turn: this.fixtureRows(
        "SELECT * FROM chat_turns WHERE id=?",
        "native-personal-turn"
      )[0],
      stopped: this.fixtureRows(
        "SELECT * FROM chat_turns WHERE id=?",
        "00000000-0000-4000-8000-000000000004"
      )[0],
      retry: this.fixtureRows<{
        start: number
        count: number
        revision: number
        versions: number
      }>(
        "SELECT p.start,p.count,max(r.revision) AS revision,count(r.revision) AS versions FROM personal_probe_summary_retry p JOIN summary_routes r USING(start,count) GROUP BY p.start,p.count"
      )[0],
      messages: this.fixtureRows<{ count: number }>(
        "SELECT count(*) AS count FROM memory_log"
      )[0]!.count,
      attempts: this.fixtureRows<{ count: number }>(
        "SELECT count(*) AS count FROM inference_attempts WHERE json_extract(payload,'$.turnId')='native-personal-turn'"
      )[0]!.count,
      activations: this.fixtureRows<{ activations: number }>(
        "SELECT activations FROM personal_probe WHERE id=1"
      )[0]!.activations,
      externalCalls: this.externalCalls.count,
      catalog: this.fixtureRows(
        "SELECT id,name,status,revision FROM agent_catalog WHERE id='00000000-0000-4000-8000-000000000006'"
      )[0],
      stopEntered: this.stopEntered,
      watchAttached: this.watchAttached,
      summaryEntered: this.summaryEntered,
      summaryAborted: this.summaryAborted,
      summaryInterrupted: this.summaryInterrupted,
      exportEntered: this.exportEntered,
      exportCleanupEntered: this.exportCleanupEntered,
      exportInterrupted: this.exportInterrupted,
      download: {
        entered: this.downloadProbe.entered,
        cleaning: this.downloadProbe.cleaning,
        closed: this.downloadProbe.closed,
        interrupted: this.downloadProbe.interrupted,
      },
      heldSummaryBuilt:
        this.fixtureRows(
          "SELECT 1 FROM memory_log l JOIN memory_nodes n ON n.start=l.id AND n.count=1 WHERE l.source='native-held-summary'"
        ).length > 0,
      observationInterrupted: this.observationInterrupted,
      events: this.events,
    })
  }

  private async whatsappProbe(request: Request): Promise<Response> {
    await this.lifecycle.start()
    const action = new URL(request.url).pathname.split("/").at(-1)
    const photo = new URL(request.url).pathname.startsWith("/whatsapp-images/")
    const voice = new URL(request.url).pathname.startsWith("/whatsapp-audio/")
    const withMedia = photo || voice
    const owner = voice
      ? "whatsapp-audio-owner"
      : photo
        ? "whatsapp-images-owner"
        : "whatsapp-owner"
    const receipt = await whatsappIdentity(
      voice
        ? "wamid.native-audio-request"
        : photo
          ? "wamid.native-image-request"
          : "wamid.native-request"
    )
    if (action === "setup") {
      if (voice) this.voiceReply()
      if (photo)
        this.fileReply((await whatsappIdentity(`${receipt.id}:image`)).id)
      const response = await this.authenticatedFetch(
        new Request(
          "https://internal/api/agent/whatsapp/configure?agent=home",
          {
            method: "POST",
            headers: {
              "x-owner-id": owner,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              operationId: crypto.randomUUID(),
              revision: 0,
              enabled: true,
            }),
          }
        )
      )
      return Response.json({ status: response.status })
    }
    if (action === "receive") {
      const { timestamp } = await request.json<{ timestamp: number }>()
      const accepted = await whatsappRpc(this).receive(owner, {
        ...receipt,
        messageId: voice
          ? "wamid.native-audio-request"
          : photo
            ? "wamid.native-image-request"
            : "wamid.native-request",
        threadId: "whatsapp:123456:15550101010",
        sender: "15550101010",
        body: "Give the synthetic answer.",
        timestamp,
        ...(withMedia
          ? {
              media: {
                id: voice ? "987654321" : "123456789",
                mime: voice ? ("audio/ogg" as const) : ("image/jpeg" as const),
                sha256: "a".repeat(64),
              },
            }
          : {}),
      })
      return Response.json({ accepted })
    }
    const sink = await getAgentByName(this.whatsappNamespace, owner)
    const rows = await this.actorRuntime.runPromise(this.whatsappStore.list())
    const turns = await this.actorRuntime.runPromise(
      this.conversations.recent()
    )
    return Response.json({
      states: rows.map((row) => row.state),
      turns: turns.map((turn) => ({
        status: turn.status,
        origin: turn.origin,
        ...(withMedia
          ? {
              attachments: turn.attachments.length,
              answer: turn.answer,
              error: turn.error,
            }
          : {}),
      })),
      sends: await sink.inspect(),
      ...(withMedia
        ? {
            activity: turns[0]
              ? await this.actorRuntime.runPromise(
                  this.conversationJournal.activity(turns[0].id)
                )
              : [],
            replyFiles: await this.actorRuntime.runPromise(
              this.workspaceService.replyFiles(turns[0]?.id ?? "")
            ),
          }
        : {}),
    })
  }
  private async emailProbe(request: Request): Promise<Response> {
    await this.lifecycle.start()
    const url = new URL(request.url),
      action = url.pathname.split("/").at(-1)
    const owner = url.pathname.startsWith("/email-held/")
      ? "email-held-owner"
      : "email-owner"
    const call = (path: string, body?: unknown) =>
      this.authenticatedFetch(
        new Request(`https://internal/api/agent/${path}?agent=home`, {
          method: body ? "POST" : "GET",
          headers: { "x-owner-id": owner, "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        })
      )
    if (action === "setup") {
      const response = await call("email/configure", {
        operationId: crypto.randomUUID(),
        revision: 0,
        enabled: true,
      })
      return Response.json({ status: response.status })
    }
    if (action === "hold")
      this.fixtureRun(
        "INSERT INTO personal_probe_email_control VALUES (1,1) ON CONFLICT(id) DO UPDATE SET held=1"
      )
    if (
      ["receive", "invalid", "attachment", "approve"].includes(action ?? "")
    ) {
      const view = Schema.decodeUnknownSync(EmailView)(
        await (await call("email")).json()
      )
      const address =
        action === "invalid" ? view.address!.replace("+", "+a") : view.address!
      const token =
        action === "approve"
          ? this.fixtureRows<{ body: string }>(
              "SELECT body FROM personal_probe_email_sends"
            )
              .map((row) => /^APPROVE (.+)$/m.exec(row.body)?.[1])
              .find(Boolean)
          : undefined
      const content =
        action === "attachment"
          ? 'Content-Type: multipart/mixed; boundary="native-boundary"\r\n\r\n--native-boundary\r\nContent-Type: text/plain\r\n\r\nPlease send the attached report back.\r\n--native-boundary\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="acceptance.txt"\r\n\r\nSynthetic email attachment.\r\n--native-boundary--'
          : `Content-Type: text/plain\r\n\r\n${token ? `APPROVE\r\n${token}` : "Give the synthetic answer."}`
      const raw = `From: owner@example.com\r\nTo: ${address}\r\nMessage-ID: <native-email-${action === "invalid" ? "receive" : action}@example.com>\r\nSubject: Native email\r\n${content}`
      const bytes = new TextEncoder().encode(raw)
      const input = await parseEmail(
        {
          from: "owner@example.com",
          to: address,
          rawSize: bytes.length,
          headers: new Headers(),
          raw: new ReadableStream({
            start(controller) {
              controller.enqueue(bytes)
              controller.close()
            },
          }),
        },
        "owner@example.com"
      )
      const { attachments, ...metadata } = input
      if (action === "attachment") {
        const policy = (
          await this.actorRuntime.runPromise(this.access.state())
        ).tools.find((tool) => tool.name === "share_file")!
        await this.actorRuntime.runPromise(
          this.access.updatePolicy("share_file", policy.revision, "ask")
        )
        this.fileReply(attachments[0]!.id, "share_file")
      }
      const form = new FormData()
      form.set("message", JSON.stringify(metadata))
      for (const file of attachments)
        form.append(
          "attachment",
          new Blob([new Uint8Array(file.bytes)], { type: file.mime }),
          file.name
        )
      const response = await this.authenticatedFetch(
        new Request("https://internal/api/agent/email/incoming?agent=home", {
          method: "POST",
          headers: { "x-owner-id": owner },
          body: form,
        })
      )
      await response.body?.cancel()
      return Response.json({ status: response.status })
    }
    const rows = await this.actorRuntime.runPromise(this.emailStore.list())
    const turns = await this.actorRuntime.runPromise(
      this.conversations.recent()
    )
    return Response.json({
      states: rows.map((row) => row.state),
      sends: this.fixtureRows(
        "SELECT body,attachments FROM personal_probe_email_sends"
      ),
      approvals: await this.actorRuntime.runPromise(this.access.pending()),
      operations: this.fixtureRows(
        "SELECT tool,status,result FROM tool_operations"
      ),
      replyFiles: await this.actorRuntime.runPromise(
        Effect.forEach(turns, (turn) =>
          this.workspaceService.replyFiles(turn.id)
        )
      ),
      turns: turns.map((turn) => ({
        status: turn.status,
        origin: turn.origin,
        attachments: turn.attachments.map((file) => ({
          name: file.name,
          kind: file.kind,
        })),
        answer: turn.answer,
      })),
    })
  }
  private async nativeCommitProbe(
    request: Request,
    action: string | undefined
  ): Promise<Response | undefined> {
    if (action === "pi-commit-probe") {
      const { kind, mode } = await request.json<{
        kind: string
        mode: string
      }>()
      const harness = await this.harness.pi()
      const before = JSON.stringify(
        this.ctx.storage.sql
          .exec("SELECT id,record FROM pi_entries ORDER BY id")
          .toArray()
      )
      const refused = new NativeCommitRefused()
      const defect = new Error("Private native settlement probe")
      const original = harness.commit.bind(harness)
      let entered!: () => void, release!: () => void
      const admitted = new Promise<void>((resolve) => {
        entered = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      harness.commit = async (change, context) => {
        try {
          return await original(change, context)
        } catch (cause) {
          if (mode === "callback") throw cause
          if (mode === "late") {
            entered()
            await held
          }
          throw mode === "raw"
            ? defect
            : Cause.fromReasons([
                Cause.makeDieReason(defect),
                Cause.makeInterruptReason(731),
              ])
        }
      }
      try {
        let program: Effect.Effect<unknown, unknown>
        if (kind === "objects") {
          const ledger = piObjectLedger(async () => harness)
          program = ledger.atomic((tx) =>
            tx.catalog().pipe(
              Effect.tap((catalog) =>
                Effect.sync(() => {
                  catalog.sequence += 9
                })
              ),
              Effect.andThen(Effect.fail(refused))
            )
          )
        } else if (kind === "planning") {
          const ledger = piPlanLedger(
            async () => harness,
            () => (ref) =>
              Effect.succeed({ ...ref, state: "valid", detail: "Probe" })
          )
          program = ledger.atomic((tx) =>
            tx.catalog().pipe(
              Effect.tap((catalog) =>
                Effect.sync(() => {
                  catalog.ids.push(crypto.randomUUID())
                })
              ),
              Effect.andThen(Effect.fail(refused))
            )
          )
        } else {
          const ledger = piDelegationLedger(
            async () => harness,
            () => ({ name: "reader" }),
            () => []
          )
          program = ledger.atomic((tx) =>
            tx.catalog().pipe(
              Effect.tap((catalog) =>
                Effect.sync(() => {
                  catalog.ids.push(731)
                })
              ),
              Effect.andThen(Effect.fail(refused))
            )
          )
        }
        const controller = new AbortController()
        let settled = false
        const pending = this.actorRuntime
          .runPromiseExit(program, { signal: controller.signal })
          .then((exit) => {
            settled = true
            return exit
          })
        this.ctx.waitUntil(pending)
        let joined = true
        if (mode === "late") {
          await admitted
          controller.abort()
          await Promise.resolve()
          joined = !settled
          release()
        }
        const exit = await pending
        const reasons = Exit.isFailure(exit) ? exit.cause.reasons : []
        return Response.json({
          reasons: reasons.map((reason) => reason._tag),
          native: reasons.some(
            (reason) => reason._tag === "Die" && reason.defect === defect
          ),
          callback: reasons.some((reason) =>
            reason._tag === "Fail"
              ? reason.error === refused
              : reason._tag === "Die" &&
                Cause.isReason(reason.defect) &&
                Cause.isFailReason(reason.defect) &&
                reason.defect.error === refused
          ),
          joined,
          unchanged:
            before ===
            JSON.stringify(
              this.ctx.storage.sql
                .exec("SELECT id,record FROM pi_entries ORDER BY id")
                .toArray()
            ),
        })
      } finally {
        harness.commit = original
      }
    }

    return undefined
  }

  private async nativeRpcProbe(
    request: Request,
    action: string | undefined
  ): Promise<Response | undefined> {
    if (action === "http-api-probe") {
      const { mode } = await request.json<{ mode: string }>()
      const previous = this.catalog.list
      this.catalog.list = () =>
        mode === "invalid"
          ? Effect.succeed([
              {
                slug: "test-agent",
                id: homeAgentId,
                name: "",
                instructions: "",
                revision: 0,
                status: "active" as const,
                createdAt: "",
                updatedAt: "",
              },
            ])
          : Effect.failCause(
              Cause.fromReasons<AgentStorageError>(
                mode === "expected"
                  ? [Cause.makeFailReason(new AgentStorageError())]
                  : mode === "defect"
                    ? [Cause.makeDieReason("Private HttpApi defect")]
                    : mode === "interrupt"
                      ? [Cause.makeInterruptReason(731)]
                      : [
                          Cause.makeFailReason(new AgentStorageError()),
                          Cause.makeDieReason(
                            "Private HttpApi compound defect"
                          ),
                          Cause.makeInterruptReason(731),
                        ]
              )
            )
      try {
        const response = await this.authenticatedFetch(
          new Request("https://agent.internal/api/agent/bots", {
            headers: { "x-owner-id": "personal-owner" },
          })
        )
        return Response.json({
          status: response.status,
          body: await response.json(),
          reasons: [],
        })
      } catch (cause) {
        if (!Cause.isCause(cause)) throw cause
        return Response.json({
          reasons: cause.reasons.map((reason) => reason._tag),
        })
      } finally {
        this.catalog.list = previous
      }
    }
    if (action === "sql-journal-probe") {
      await this.harness.pi()
      const source = this.ctx.storage.sql
        .exec<{ id: number; record: string }>(
          "SELECT id,record FROM pi_entries ORDER BY id"
        )
        .toArray()
      const exit = await this.actorRuntime.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return yield* sql`SELECT id,record FROM pi_entries ORDER BY id`.pipe(
              Effect.map(
                Schema.decodeUnknownSync(
                  Schema.Array(
                    Schema.Struct({ id: Schema.Int, record: Schema.String })
                  )
                )
              )
            )
          })
        ).pipe(Effect.provide(SqliteDriver.layer({ db: this.ctx.storage.sql })))
      )
      if (Exit.isFailure(exit)) throw exit.cause
      const after = this.ctx.storage.sql
        .exec<{ id: number; record: string }>(
          "SELECT id,record FROM pi_entries ORDER BY id"
        )
        .toArray()
      return Response.json({
        entries: source.length,
        matches: JSON.stringify(source) === JSON.stringify(exit.value),
        unchanged: JSON.stringify(source) === JSON.stringify(after),
      })
    }
    if (action === "owner-rpc-probe")
      return Response.json(
        await this.backgroundNamespace
          .getByName("rpc-failure-probe")
          .ownerRpcOutcomes(this.ctx.id.toString())
      )
    if (action === "activity-rpc-probe")
      return Response.json(
        await this.backgroundNamespace
          .getByName("rpc-failure-probe")
          .activityRpcOutcomes(this.ctx.id.toString())
      )
    if (action === "agent-rpc-probe")
      return Response.json(
        await this.backgroundNamespace
          .getByName("rpc-failure-probe")
          .agentRpcOutcomes(this.ctx.id.toString())
      )
    if (action === "parent-rpc-probe") {
      return Response.json(
        await this.backgroundNamespace
          .getByName("rpc-failure-probe")
          .parentRpcOutcomes(this.ctx.id.toString())
      )
    }
    if (action === "background-rpc-probe") {
      const child = this.backgroundNamespace.getByName("rpc-failure-probe")
      const results = []
      for (const protocol of ["legacy", "v1"]) {
        for (const kind of [
          "expected",
          "defect",
          "interrupt",
          "mixed",
          "invalid",
        ]) {
          if (protocol === "legacy" && kind === "invalid") continue
          const work =
            protocol === "legacy"
              ? backgroundNative(() => child.probeFailure(kind))
              : backgroundRemote(this.ctx.id.toString(), () => ({
                  invokeV1: () => child.probeOutcome(kind),
                })).read(1)
          const exit = await Effect.runPromiseExit(work)
          results.push({
            protocol,
            kind,
            reasons: Exit.isFailure(exit)
              ? exit.cause.reasons.map((reason) => ({
                  tag: reason._tag,
                  code: reason._tag === "Fail" ? reason.error.code : undefined,
                }))
              : [],
          })
        }
      }
      return Response.json(results)
    }

    return undefined
  }

  private async commandsProbe(
    _request: Request,
    action: string | undefined
  ): Promise<Response | undefined> {
    if (action === "command-start" || action === "command-hold") {
      await this.harness.pi()
      const grant = await this.actorRuntime.runPromise(
        this.accessStore.policy("run_command")
      )
      await this.actorRuntime.runPromise(
        this.accessStore.update("run_command", grant.revision, "allow")
      )
      const held = action === "command-hold"
      if (held)
        this.commandProbe.wait = new Promise<void>((resolve) => {
          this.commandProbe.release = resolve
        })
      const faux = fauxProvider({
        provider: "openai",
        models: [{ id: "gpt-6-luna", contextWindow: 8192, maxTokens: 2048 }],
        tokensPerSecond: 1000000,
      })
      this.models.setProvider(faux.provider)
      faux.setResponses(
        Array.from({ length: 6 }, () => async (context) => {
          const summary = "The Native shell command completed successfully."
          if (
            context.messages.some(
              (message) =>
                message.role === "system" &&
                typeof message.content === "string" &&
                message.content.startsWith(
                  "You are a context summarization assistant."
                )
            )
          )
            return fauxAssistantMessage(summary)
          if (JSON.stringify(context.messages).includes(summary))
            return fauxAssistantMessage("Native Pi command complete")
          const result = context.messages.find(
            (message) => message.role === "toolResult"
          )
          if (result) {
            if (
              result.isError ||
              !JSON.stringify(result.content).includes("Native shell command")
            )
              throw new Error("Native command tool result was not successful")
            return fauxAssistantMessage("Native Pi command complete")
          }
          return fauxAssistantMessage(
            fauxToolCall(
              "run_command",
              { command: held ? "hold fixture" : "printf fixture" },
              { id: held ? "native-command-held-call" : "native-command-call" }
            ),
            { stopReason: "toolUse" }
          )
        })
      )
      const accepted = await this.acceptMessage({
        operationId: held
          ? "00000000-0000-4000-8000-000000000020"
          : "native-command-turn",
        text: "Run the synthetic private command.",
      })
      return Response.json({ status: accepted.status })
    }
    if (action === "command-stop")
      return this.authenticatedFetch(
        new Request("https://internal/api/agent/cancel", {
          method: "POST",
          body: JSON.stringify({
            operationId: "00000000-0000-4000-8000-000000000020",
          }),
        })
      )
    if (action === "command-release") this.commandProbe.release?.()
    if (action === "command-read" || action === "command-release")
      return Response.json({
        command: await this.actorRuntime.runPromise(
          this.conversations.get("native-command-turn")
        ),
        stopped: await this.actorRuntime.runPromise(
          this.conversations.get("00000000-0000-4000-8000-000000000020")
        ),
        probe: {
          entered: this.commandProbe.entered,
          aborted: this.commandProbe.aborted,
        },
        terminal: await this.terminalNamespace
          .getByName(this.ctx.id.toString())
          .inspect(),
      })
    if (action === "command-pending")
      return Response.json({
        stopped: await this.actorRuntime.runPromise(
          this.conversations.get("00000000-0000-4000-8000-000000000020")
        ),
        probe: {
          entered: this.commandProbe.entered,
          aborted: this.commandProbe.aborted,
        },
        terminal: await this.terminalNamespace
          .getByName(this.ctx.id.toString())
          .inspect(),
      })

    return undefined
  }

  private async backgroundWorkProbe(
    _request: Request,
    action: string | undefined
  ): Promise<Response | undefined> {
    if (action === "background-held-start") {
      this.fixtureRun(
        "INSERT INTO model_credentials(provider,value,seed) VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value",
        "openai",
        JSON.stringify({
          type: "oauth",
          access: "native-background-access",
          refresh: "native-background-refresh",
          expires: Date.now() + 900_000,
          clientId: "native-client",
        }),
        ""
      )
      const source = (await this.actorRuntime.runPromise(
        this.conversations.get("00000000-0000-4000-8000-000000000020")
      ))!
      const row = await this.actorRuntime.runPromise(
        this.backgroundMailbox.create(
          {
            objective: "Native held background provider",
            tasks: [
              { name: "Held", task: "Wait for provider cleanup", tools: [] },
            ],
          },
          {
            turnId: source.id,
            taskId: 910002,
            conversationId: Number(source.session_id),
            route: source.routing!,
            memory: "Synthetic",
          },
          Date.now() + 60_000
        )
      )
      const child = this.backgroundNamespace.getByName(
        backgroundObjectName(this.ctx.id.toString(), row.id)
      )
      await child.holdProvider()
      await child.start(this.ctx.id.toString(), row.id)
      return Response.json({ id: row.id })
    }
    if (action?.startsWith("background-held-")) {
      const child = this.backgroundNamespace.getByName(
        backgroundObjectName(this.ctx.id.toString(), 910002)
      )
      if (action === "background-held-dispose") await child.disposeHeld()
      if (action === "background-held-release") await child.releaseHeld()
      if (action === "background-held-cancel") {
        await this.actorRuntime.runPromise(
          this.backgroundMailbox.cancel(910002, undefined, Date.now() + 60_000)
        )
        this.fixtureRun("DELETE FROM model_credentials WHERE provider='openai'")
      }
      return Response.json(await child.inspectHeld())
    }
    if (action === "activity") {
      const row = (
        await this.actorRuntime.runPromise(this.backgroundMailbox.list())
      ).find(
        (value) =>
          value.handoff.input.objective === "Native background workflow"
      )!
      const before = this.fixtureRows<{ n: number }>(
        "SELECT count(*) AS n FROM chat_turns"
      )[0]!.n
      const directory = activityDirectory(
        "personal-owner",
        this.env.AGENT.getByName("personal-owner"),
        (name) => this.env.AGENT.getByName(name),
        (work) => this.ctx.waitUntil(work)
      )
      const page = await this.actorRuntime.runPromise(
        activityRequest(
          directory,
          homeAgentId,
          new Request("https://local/activity?scope=all"),
          "activity"
        )
      )
      const record = await this.actorRuntime.runPromise(
        activityRequest(
          directory,
          homeAgentId,
          new Request(
            `https://local/activity/conversations/${row.handoff.reportId}`
          ),
          `activity/conversations/${row.handoff.reportId}`
        )
      )
      return Response.json({
        pageStatus: page.status,
        page: await page.json(),
        recordStatus: record.status,
        record: await record.json(),
        before,
        after: this.fixtureRows<{ n: number }>(
          "SELECT count(*) AS n FROM chat_turns"
        )[0]!.n,
      })
    }
    if (action === "background-start") {
      await this.harness.pi()
      const grant = await this.actorRuntime.runPromise(
        this.accessStore.policy("background_tasks")
      )
      await this.actorRuntime.runPromise(
        this.accessStore.update("background_tasks", grant.revision, "allow")
      )
      const faux = fauxProvider({
        provider: "openai",
        models: [{ id: "gpt-6-luna", contextWindow: 8192, maxTokens: 2048 }],
        tokensPerSecond: 1000000,
      })
      this.models.setProvider(faux.provider)
      const brief = {
        objective: "Native background workflow",
        tasks: [
          { name: "Draft", task: "Draft private supplied-text findings" },
          { name: "Critique", task: "Critique private supplied-text findings" },
        ],
      }
      faux.setResponses(
        Array.from({ length: 12 }, () => async (context) => {
          const messages = JSON.stringify(context.messages)
          const summary = "The background_tasks call was accepted."
          if (
            context.messages.some(
              (message) =>
                message.role === "system" &&
                typeof message.content === "string" &&
                message.content.startsWith(
                  "You are a context summarization assistant."
                )
            )
          )
            return fauxAssistantMessage(
              messages.includes(
                "These are child findings from an earlier request"
              )
                ? "These are child findings from an earlier request; ready to reconcile."
                : summary
            )
          if (
            messages.includes(
              "These are child findings from an earlier request"
            )
          )
            return fauxAssistantMessage("Native background findings reconciled")
          return messages.includes(summary) ||
            context.messages.some((message) => message.role === "toolResult")
            ? fauxAssistantMessage("Native background accepted")
            : fauxAssistantMessage(
                fauxToolCall("background_tasks", brief, {
                  id: "native-background-call",
                }),
                { stopReason: "toolUse" }
              )
        })
      )
      const accepted = await this.acceptMessage({
        operationId: "native-background-workflow",
        text: "Compare supplied-text draft branches in background.",
      })
      return Response.json({ status: accepted.status })
    }
    if (action === "background-read") {
      const rows = await this.actorRuntime.runPromise(
        this.backgroundMailbox.list()
      )
      const row = rows.find(
        (value) =>
          value.handoff.input.objective === "Native background workflow"
      )
      return Response.json({
        row,
        group: row
          ? await this.actorRuntime.runPromise(this.background.read(row.id))
          : null,
        parent: await this.actorRuntime.runPromise(
          this.conversations.get("native-background-workflow")
        ),
        report: row
          ? await this.actorRuntime.runPromise(
              this.conversations.get(row.handoff.reportId)
            )
          : null,
      })
    }
    if (action === "background-mailbox") {
      const route = {
        ...resolveRoute("conversation", {
          model: "gpt-6-luna",
          thinking: "low",
        }),
        contextWindow: 8192,
      }
      const source = (
        await this.actorRuntime.runPromise(
          this.conversations.admit(
            {
              operationId: "native-background-parent",
              text: "Draft a private background report.",
            },
            undefined,
            [],
            route,
            { discoveryDeadline: await this.runner.armDiscovery() }
          )
        )
      ).turn
      const row = await this.actorRuntime.runPromise(
        this.backgroundMailbox.create(
          {
            objective: "Native background mailbox",
            tasks: [
              { name: "Draft", task: "Private supplied-text draft", tools: [] },
            ],
          },
          {
            turnId: source.id,
            taskId: 910001,
            conversationId: 1,
            route,
            memory: "Local reference",
          },
          Date.now() + 60_000
        )
      )
      await this.actorRuntime.runPromise(
        this.conversations.finish(
          source,
          [{ id: source.id, delivery: "answered" }],
          "Background accepted",
          null
        )
      )
      await this.actorRuntime.runPromise(
        this.backgroundMailbox.observed(row.id, {
          id: row.id,
          turnId: source.id,
          conversationId: 1,
          route,
          objective: row.handoff.input.objective,
          createdAt: row.handoff.createdAt,
          deadline: row.handoff.deadline,
          status: "completed",
          children: [],
        })
      )
      const admission = {
        transactionGroup: this.db,
        stop: (id: string) =>
          this.conversations.requestStop(id).pipe(Effect.asVoid),
        admit: (
          h: typeof row.handoff,
          report: string,
          discoveryDeadline: number
        ) =>
          this.conversations
            .admit(
              {
                operationId: h.reportId,
                text: report,
                origin: { kind: "background", groupId: h.id, turnId: h.turnId },
              },
              undefined,
              [],
              h.route,
              { discoveryDeadline }
            )
            .pipe(Effect.map((result) => result.turn.id)),
      }
      const failed = await this.actorRuntime.runPromiseExit(
        this.backgroundMailbox.deliver(
          {
            ...admission,
            admit: (h, report, discoveryDeadline) =>
              admission
                .admit(h, report, discoveryDeadline)
                .pipe(
                  Effect.andThen(
                    Effect.die(new Error("Synthetic report admission fault"))
                  )
                ),
          },
          await this.runner.armDiscovery()
        )
      )
      const rolledBack =
        Exit.isFailure(failed) &&
        Cause.hasDies(failed.cause) &&
        !(await this.actorRuntime.runPromise(
          this.conversations.get(row.handoff.reportId)
        )) &&
        (await this.actorRuntime.runPromise(this.backgroundMailbox.get(row.id)))
          ?.status === "ready"
      if (!rolledBack)
        throw new Error("Native background transaction did not roll back")
      const delivered = await this.actorRuntime.runPromise(
        this.backgroundMailbox.deliver(
          admission,
          await this.runner.armDiscovery()
        )
      )
      const replay = await this.actorRuntime.runPromise(
        this.backgroundMailbox.deliver(
          admission,
          await this.runner.armDiscovery()
        )
      )
      const turn = (await this.actorRuntime.runPromise(
        this.conversations.get(row.handoff.reportId)
      ))!
      await this.actorRuntime.runPromise(
        this.conversations.finish(
          turn,
          [{ id: turn.id, delivery: "answered" }],
          "Native background report acknowledged",
          null
        )
      )
      return Response.json({
        rolledBack,
        delivered,
        replay,
        row: await this.actorRuntime.runPromise(
          this.backgroundMailbox.get(row.id)
        ),
        turn: await this.actorRuntime.runPromise(
          this.conversations.get(turn.id)
        ),
      })
    }
    if (action === "background-mailbox-read") {
      const row = await this.actorRuntime.runPromise(
        this.backgroundMailbox.get(910001)
      )
      return Response.json({
        row,
        turn: row
          ? await this.actorRuntime.runPromise(
              this.conversations.get(row.handoff.reportId)
            )
          : null,
      })
    }

    return undefined
  }

  private async delegatedWorkProbe(
    _request: Request,
    action: string | undefined
  ): Promise<Response | undefined> {
    if (action === "delegation-start") {
      await this.harness.pi()
      const grant = await this.actorRuntime.runPromise(
        this.accessStore.policy("delegate_tasks")
      )
      await this.actorRuntime.runPromise(
        this.accessStore.update("delegate_tasks", grant.revision, "allow")
      )
      const faux = fauxProvider({
        provider: "openai",
        models: [{ id: "gpt-6-luna", contextWindow: 8192, maxTokens: 2048 }],
        tokensPerSecond: 1000000,
      })
      this.models.setProvider(faux.provider)
      const brief = {
        objective: "Native delegation",
        tasks: [
          { name: "Research", task: "Draft private findings", tools: [] },
          { name: "Critique", task: "Critique privately", tools: [] },
        ],
      }
      faux.setResponses(
        Array.from({ length: 8 }, () => async (context, options) => {
          await this.actorRuntime.runPromise(
            this.delegations.request(options!.sessionId!),
            {
              signal: options?.signal,
            }
          )
          if (
            JSON.stringify(context.messages).includes(
              "You are the delegated child"
            )
          )
            return fauxAssistantMessage("Native child findings")
          // Compaction has no tools. Return a summary rather than another tool call.
          const summary =
            "The delegate_tasks call completed with Native child findings."
          if (
            context.messages.some(
              (message) =>
                message.role === "system" &&
                typeof message.content === "string" &&
                message.content.startsWith(
                  "You are a context summarization assistant."
                )
            )
          )
            return fauxAssistantMessage(summary)
          return JSON.stringify(context.messages).includes(summary) ||
            context.messages.some((message) => message.role === "toolResult")
            ? fauxAssistantMessage("Native delegation complete")
            : fauxAssistantMessage(
                fauxToolCall("delegate_tasks", brief, {
                  id: "native-delegation-call",
                }),
                { stopReason: "toolUse" }
              )
        })
      )
      const accepted = await this.acceptMessage({
        operationId: "native-delegation-turn",
        text: "Compare private draft branches.",
      })
      return Response.json({ status: accepted.status })
    }
    if (action === "delegation-read") {
      await this.lifecycle.start()
      return Response.json({
        turn: await this.actorRuntime.runPromise(
          this.conversations.get("native-delegation-turn")
        ),
        groups: await this.actorRuntime.runPromise(this.delegations.list()),
      })
    }
    if (action === "admit") {
      const admitted = await this.acceptMessage({
        operationId: "native-personal-turn",
        text: "Give the synthetic answer.",
      })
      if (admitted.status !== 202)
        throw new Error("Native message admission failed")
    }
    if (action === "stop") {
      await this.actorRuntime.runPromise(
        this.conversations.admit(
          {
            operationId: "00000000-0000-4000-8000-000000000004",
            text: "Stop before dispatch.",
          },
          undefined,
          undefined,
          undefined,
          { discoveryDeadline: await this.runner.armDiscovery() }
        )
      )
      const stopped = await this.authenticatedFetch(
        new Request("https://internal/api/agent/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operationId: "00000000-0000-4000-8000-000000000004",
          }),
        })
      )
      if (stopped.status !== 202) throw new Error("Native stop command failed")
    }
    if (action === "retry") {
      const source = await this.actorRuntime.runPromise(
        this.memory.append(
          "native-summary-source",
          "user",
          "Keep the synthetic summary source."
        )
      )
      const part = { start: source.id, count: 1 }
      await this.actorRuntime.runPromise(
        this.summaryRoutes.pin(part, resolveRoute("memory"))
      )
      for (let n = 0; n < 3; n++)
        await this.actorRuntime.runPromise(this.memory.failNode(part, 10000))
      this.fixtureRun(
        "INSERT INTO personal_probe_summary_retry VALUES (?,?)",
        part.start,
        part.count
      )
      const retryRequest = () =>
        new Request("https://internal/api/agent/memory/retry", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...part,
            operationId: "00000000-0000-4000-8000-000000000005",
          }),
        })
      if (
        !(await this.authenticatedFetch(retryRequest())).ok ||
        !(await this.authenticatedFetch(retryRequest())).ok
      )
        throw new Error("Native memory retry or replay failed")
    }

    return undefined
  }

  private async providerWorkProbe(
    _request: Request,
    action: string | undefined
  ): Promise<Response | undefined> {
    if (action === "usage-start") {
      await this.lifecycle.start()
      const observation = await this.observeInference(
        resolveRoute("conversation"),
        "native-usage",
        "conversation"
      )
      await observation.end("cancelled", "Stopped by user")
      await observation.usage({
        id: "native-usage-response",
        model: "gpt-6.1-sol",
        input: 123,
        cached: 100,
        output: 17,
      })
      await observation.usage({
        id: "native-usage-response",
        model: "gpt-6.1-sol",
        input: 999,
        cached: 0,
        output: 999,
      })
      await observation.end("completed")
      await this.observeInference(
        resolveRoute("conversation"),
        "native-usage",
        "compaction"
      )
    }
    if (action === "usage-start" || action === "usage-read") {
      await this.lifecycle.start()
      return Response.json({
        attempts: (
          await this.actorRuntime.runPromise(this.inferenceUsage.recent())
        ).filter((a) => a.turnId === "native-usage"),
        totals: await this.actorRuntime.runPromise(
          this.inferenceUsage.totals("native-usage")
        ),
        reports: this.fixtureRows(
          "SELECT * FROM model_usage WHERE id='native-usage-response'"
        ),
      })
    }
    if (action === "hold-provider") {
      const wait = new Promise<void>((resolve) => {
        this.providerProbe.release = resolve
      })
      const models = createAgentModels(
        accountCredentials(async () => ({
          type: "oauth",
          access: "native-provider-access",
          refresh: "native-provider-refresh",
          expires: Date.now() + 900_000,
          clientId: "native-client",
        })),
        {
          start: (current) =>
            this.actorRuntime.runSync(
              Effect.flatMap(PiModelStreams, (streams) =>
                streams.start(current)
              )
            ),
          onAttempt: () =>
            this.observeInference(
              resolveRoute("conversation"),
              "native-held-provider",
              "conversation"
            ),
        }
      )
      const model = models.getModel("openai", "gpt-6.1-sol")!
      this.ctx.waitUntil(
        models
          .completeSimple(
            model,
            {
              messages: [
                { role: "user", content: "Native held provider", timestamp: 0 },
              ],
            },
            {
              reasoning: "medium",
              fetch: async (_input, options) => {
                this.providerProbe.entered = true
                options?.signal?.addEventListener(
                  "abort",
                  () => {
                    this.providerProbe.aborted = true
                  },
                  { once: true }
                )
                return new Response(
                  new ReadableStream<Uint8Array>({
                    start: (target) =>
                      target.enqueue(
                        new TextEncoder().encode(
                          'data: {"type":"response.created","response":{"id":"native-held-response","model":"gpt-6.1-sol","status":"in_progress"}}\n\n'
                        )
                      ),
                    cancel: async () => {
                      this.providerProbe.cleaning = true
                      await wait
                      this.providerProbe.closed = true
                      this.events.push("native.provider.closed")
                    },
                  }),
                  { headers: { "content-type": "text/event-stream" } }
                )
              },
            }
          )
          .then(
            () => {
              this.providerProbe.settled = true
            },
            (cause) => {
              this.providerProbe.settled = true
              this.providerProbe.interrupted =
                Cause.isCause(cause) && Cause.hasInterrupts(cause)
            }
          )
      )
    }
    if (action === "release-provider") this.providerProbe.release?.()

    return undefined
  }

  private async credentialWorkProbe(
    _request: Request,
    action: string | undefined
  ): Promise<Response | undefined> {
    if (action === "credential-start") {
      await this.lifecycle.start()
      this.fixtureRun(
        "INSERT INTO model_credentials(provider,value,seed) VALUES (?,?,?)",
        "openai",
        JSON.stringify({
          type: "oauth",
          access: "native-before-access",
          refresh: "native-before-refresh",
          expires: 0,
          clientId: "native-client",
        }),
        ""
      )
      this.credentialProbe.wait = new Promise<void>((resolve) => {
        this.credentialProbe.release = resolve
      })
      this.ctx.waitUntil(
        this.actorRuntime
          .runPromiseExit(this.credentialService.resolve("openai"))
          .then((exit) => {
            this.credentialProbe.interrupted =
              Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
          })
      )
    }
    if (action === "credential-replay") {
      await this.lifecycle.start()
      const exit = await this.actorRuntime.runPromiseExit(
        this.credentialService.resolve("openai")
      )
      return Response.json({
        blocked:
          Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) =>
              reason._tag === "Fail" &&
              reason.error._tag === "CredentialUnavailable"
          ),
        calls: this.credentialProbe.calls,
        attempts: this.fixtureRows<{ attempts: number }>(
          "SELECT attempts FROM personal_probe_credential WHERE id=1"
        )[0]?.attempts,
        pending: this.fixtureRows("SELECT 1 FROM model_credential_refresh")
          .length,
      })
    }
    if (action === "release-credential") this.credentialProbe.release?.()
    if (action === "code") {
      const input = { id: "native-code", code: "return 3", data: "null" }
      const submit = () =>
        this.authenticatedFetch(
          new Request("https://internal/api/agent/execution/run", {
            method: "POST",
            body: JSON.stringify(input),
          })
        )
      const first = await submit(),
        replay = await submit()
      const saved = await this.actorRuntime.runPromise(
        this.executions.run(input)
      )
      return Response.json({
        first: first.status,
        replay: replay.status,
        saved,
        calls: this.codeProbe.calls,
      })
    }
    if (action === "hold-code" || action === "uncertain-code") {
      this.codeProbe.wait = new Promise<void>((resolve) => {
        this.codeProbe.release = resolve
      })
      const accepted = await this.authenticatedFetch(
        new Request("https://internal/api/agent/execution/run", {
          method: "POST",
          body: JSON.stringify({
            id: "native-held-code",
            code: action === "uncertain-code" ? "hold-fetch" : "hold",
            data: "null",
          }),
        })
      )
      if (accepted.status !== 202)
        throw new Error("Native held execution was not admitted")
    }
    if (action === "replay-code") {
      const accepted = await this.authenticatedFetch(
        new Request("https://internal/api/agent/execution/run", {
          method: "POST",
          body: JSON.stringify({
            id: "native-held-code",
            code: "hold-fetch",
            data: "null",
          }),
        })
      )
      if (accepted.status !== 202)
        throw new Error("Native held execution replay was not admitted")
      const run = await this.actorRuntime.runPromise(
        this.executions.run({
          id: "native-held-code",
          code: "hold-fetch",
          data: "null",
        })
      )
      return Response.json({ run, calls: this.codeProbe.calls })
    }
    if (action === "release-code") this.codeProbe.release?.()

    return undefined
  }

  private async workspaceFilesProbe(
    _request: Request,
    action: string | undefined
  ): Promise<Response | undefined> {
    if (action === "hold") await this.holdObservation()
    if (action === "files") {
      const id = "00000000-0000-4000-8000-000000000014"
      const uploading = () => {
        const form = new FormData()
        form.set("id", id)
        form.set(
          "file",
          new File(["Native private file 🍀"], "native.md", {
            type: "text/plain",
          })
        )
        return this.authenticatedFetch(
          new Request("https://internal/api/agent/files/upload", {
            method: "POST",
            body: form,
          })
        )
      }
      const first = await uploading(),
        replay = await uploading()
      const renamed = await this.authenticatedFetch(
        new Request(`https://internal/api/agent/files/${id}/rename`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "renamed.md" }),
        })
      )
      const content = await this.authenticatedFetch(
        new Request(`https://internal/api/agent/files/${id}/text`)
      )
      await this.authenticatedFetch(
        new Request(`https://internal/api/agent/files/${id}/trash`, {
          method: "POST",
        })
      )
      const trashed = await this.authenticatedFetch(
        new Request(`https://internal/api/agent/files/${id}/text`)
      )
      await this.authenticatedFetch(
        new Request(`https://internal/api/agent/files/${id}/restore`, {
          method: "POST",
        })
      )
      const preparedUpload = (fileId: string, file: File) => {
        const form = new FormData()
        form.set("id", fileId)
        form.set("file", file)
        return this.authenticatedFetch(
          new Request("https://internal/api/agent/files/upload", {
            method: "POST",
            body: form,
          })
        )
      }
      const pdfId = "00000000-0000-4000-8000-000000000015",
        videoId = "00000000-0000-4000-8000-000000000016"
      if (
        !(
          await preparedUpload(
            pdfId,
            new File(["%PDF-synthetic"], "native.pdf", {
              type: "application/pdf",
            })
          )
        ).ok
      )
        throw new Error("Native PDF upload failed")
      await this.actorRuntime.runPromise(this.workspaceService.extractNext())
      if (
        !(
          await preparedUpload(
            videoId,
            new File(
              [Uint8Array.of(0, 0, 0, 24, 102, 116, 121, 112)],
              "native.mp4",
              { type: "video/mp4" }
            )
          )
        ).ok
      )
        throw new Error("Native video upload failed")
      await this.actorRuntime.runPromise(this.workspaceService.extractNext())
      const prepared = await this.actorRuntime.runPromise(
        this.workspaceService.list()
      )
      return Response.json({
        firstStatus: first.status,
        first: await first.json(),
        replayStatus: replay.status,
        replay: await replay.json(),
        renamed: await renamed.json(),
        content: await content.json(),
        trashedStatus: trashed.status,
        pdf: prepared.find((file) => file.id === pdfId),
        video: prepared.find((file) => file.id === videoId),
      })
    }
    if (action === "terminal-import" || action === "terminal-read") {
      const id = "00000000-0000-4000-8000-000000000017",
        fileId = "00000000-0000-4000-8000-000000000014",
        exportId = "00000000-0000-4000-8000-000000000018",
        cancelledId = "00000000-0000-4000-8000-000000000019"
      const target = this.terminalNamespace.getByName(this.ctx.id.toString())
      const call = (path: string, body?: unknown) =>
        this.authenticatedFetch(
          new Request(
            `https://internal/api/agent/${path}`,
            body === undefined
              ? undefined
              : { method: "POST", body: JSON.stringify(body) }
          )
        )
      if (action === "terminal-import") {
        const first = await call("terminal/files/import", { id, fileId })
        await target.inspect()
        await call(`files/${fileId}/trash`, {})
        const replay = await call("terminal/files/import", { id, fileId })
        await call(`files/${fileId}/restore`, {})
        const conflict = await call("terminal/files/import", {
          id,
          fileId: "00000000-0000-4000-8000-000000000015",
        })
        const exporting = await call("terminal/export", {
          id: exportId,
          path: "/workspace/native.txt",
        })
        await target.inspect()
        await call(`terminal/${cancelledId}/cancel`, {})
        const cancelled = await call("terminal/files/import", {
          id: cancelledId,
          fileId,
        })
        const state = await target.inspect()
        const receipt = await call(`terminal/${id}`)
        const download = await call(`terminal/${exportId}/file`)
        return Response.json({
          firstStatus: first.status,
          first: await first.json(),
          replayStatus: replay.status,
          replay: await replay.json(),
          conflict: conflict.status,
          exporting: exporting.status,
          cancelled: cancelled.status,
          state,
          receipt: await receipt.json(),
          downloadStatus: download.status,
          download: await download.text(),
        })
      }
      const replay = await call("terminal/files/import", { id, fileId })
      const receipt = await call(`terminal/${id}`)
      const download = await call(`terminal/${exportId}/file`)
      return Response.json({
        replayStatus: replay.status,
        replay: await replay.json(),
        receipt: await receipt.json(),
        downloadStatus: download.status,
        download: await download.text(),
        state: await target.inspect(),
      })
    }
    if (action === "file-read") {
      const response = await this.authenticatedFetch(
        new Request("https://internal/api/agent/files")
      )
      return Response.json({
        status: response.status,
        list: await response.json(),
      })
    }

    return undefined
  }

  private async structuredWorkProbe(
    _request: Request,
    action: string | undefined
  ): Promise<Response | undefined> {
    if (action === "objects") {
      const change = (value: unknown) =>
        this.authenticatedFetch(
          new Request("https://internal/api/agent/objects/mutate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(value),
          })
        )
      const input = {
        id: "00000000-0000-4000-8000-000000000007",
        operationId: "00000000-0000-4000-8000-000000000008",
        expectedRevision: 0,
        action: {
          type: "create",
          title: "Native checklist",
          notes: "Synthetic",
          tasks: [],
        },
      }
      const first = await change(input),
        replay = await change(input)
      const update = {
        ...input,
        operationId: "00000000-0000-4000-8000-000000000009",
        expectedRevision: 1,
        action: {
          type: "update",
          changes: [{ type: "edit", title: "Native edited checklist" }],
        },
      }
      const updated = await change(update)
      const stale = await change({
        ...update,
        operationId: "00000000-0000-4000-8000-000000000010",
      })
      await this.actorRuntime.runPromise(this.objects.offered(99))
      return Response.json({
        firstStatus: first.status,
        first: await first.json(),
        replayStatus: replay.status,
        replay: await replay.json(),
        updated: await updated.json(),
        staleStatus: stale.status,
        stale: await stale.json(),
        context: await this.actorRuntime.runPromise(this.objects.context()),
      })
    }
    if (action === "object-read") {
      const response = await this.authenticatedFetch(
        new Request(
          "https://internal/api/agent/objects/00000000-0000-4000-8000-000000000007"
        )
      )
      return Response.json({
        status: response.status,
        detail: await response.json(),
        context: await this.actorRuntime.runPromise(this.objects.context()),
      })
    }
    if (action === "planning") {
      const turnId = "00000000-0000-4000-8000-000000000012"
      await this.actorRuntime.runPromise(
        this.conversations.admit(
          {
            operationId: turnId,
            text: "Inspect the synthetic checklist in a private plan.",
          },
          undefined,
          undefined,
          undefined,
          { discoveryDeadline: await this.runner.armDiscovery() }
        )
      )
      await this.actorRuntime.runPromise(this.conversations.prepare(turnId))
      const source = await this.actorRuntime.runPromise(this.planSource(turnId))
      if (!source) throw new Error("Native planning source unavailable")
      const input: PlanUpdate = {
        id: "00000000-0000-4000-8000-000000000011",
        operationId: "tool:99001",
        relation: "new",
        expectedRevision: 0,
        inputRevision: source.inputRevision,
        reason: "Checklist inspected",
        draft: {
          objective: "Inspect the private checklist",
          constraints: ["Do not publish"],
          criteria: ["Checklist saved at revision 2"],
          steps: [
            {
              id: "inspect",
              title: "Inspect checklist",
              status: "completed",
              evidence: [
                {
                  kind: "object",
                  id: "00000000-0000-4000-8000-000000000007",
                  revision: 2,
                },
              ],
              note: "Saved source, agent-reported outcome",
            },
          ],
          nextAction: "",
          blocker: "",
          complete: true,
        },
      }
      const first = await this.actorRuntime.runPromise(
        this.plans.update(input, source)
      )
      const replay = await this.actorRuntime.runPromise(
        this.plans.update(input, source)
      )
      const changed = await this.authenticatedFetch(
        new Request("https://internal/api/agent/objects/mutate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: "00000000-0000-4000-8000-000000000007",
            operationId: "00000000-0000-4000-8000-000000000013",
            expectedRevision: 2,
            action: {
              type: "update",
              changes: [{ type: "edit", title: "Native planning revision" }],
            },
          }),
        })
      )
      if (!changed.ok) throw new Error("Native planning evidence update failed")
      const response = await this.authenticatedFetch(
        new Request(`https://internal/api/agent/plans/${input.id}`)
      )
      const reopened = await response.json()
      await this.actorRuntime.runPromise(this.plans.cancel(turnId))
      // Discovery may already have given the pump a live control owner. Use
      // production Stop and observe its joined release instead of trying to
      // complete that owner's row from this fixture request.
      await this.actorRuntime.runPromise(this.stopConversation(turnId))
      let stopped = await this.actorRuntime.runPromise(
        this.conversations.get(turnId)
      )
      for (
        let attempt = 0;
        attempt < 200 &&
        (stopped?.status !== "cancelled" ||
          !stopped.control ||
          stopped.control.owner !== null);
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        stopped = await this.actorRuntime.runPromise(
          this.conversations.get(turnId)
        )
      }
      if (
        stopped?.status !== "cancelled" ||
        !stopped.control ||
        stopped.control.owner !== null ||
        stopped.control.unconfirmed !== null
      )
        throw new Error(
          `Native fixture planning turn did not stop: ${JSON.stringify({
            status: stopped?.status,
            control: stopped?.control,
          })}`
        )
      return Response.json({
        first,
        replay,
        status: response.status,
        reopened,
        cancelled: await this.actorRuntime.runPromise(
          this.plans.read(input.id)
        ),
      })
    }
    if (action === "plan-read") {
      const response = await this.authenticatedFetch(
        new Request(
          "https://internal/api/agent/plans/00000000-0000-4000-8000-000000000011"
        )
      )
      return Response.json({
        status: response.status,
        detail: await response.json(),
      })
    }
    if (action === "profiles") {
      const change = (path: string, value: unknown) =>
        this.authenticatedFetch(
          new Request(`https://internal/api/agent/bots/${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-owner-id": "personal-owner",
            },
            body: JSON.stringify(value),
          })
        )
      const input = {
        id: "00000000-0000-4000-8000-000000000006",
        name: "Native catalog",
        instructions: "Synthetic",
      }
      const first = await change("create", input),
        replay = await change("create", input)
      const updated = await change("update", {
        ...input,
        name: "Native updated",
      })
      const homeArchive = await change("archive", {
        id: homeAgentId,
        archived: true,
      })
      const homeInput = {
        id: homeAgentId,
        name: "Native probe",
        instructions: "Synthetic probe only.",
      }
      await change("update", homeInput)
      const newer = await change("update", homeInput)
      await this.configureBot("personal-owner", await newer.json())
      return Response.json({
        firstStatus: first.status,
        first: await first.json(),
        replayStatus: replay.status,
        replay: await replay.json(),
        updated: await updated.json(),
        homeArchive: homeArchive.status,
        projection: this.terminalProbe.projections.at(-1),
        released: this.terminalProbe.released,
      })
    }

    return undefined
  }

  private async heldRunnerProbe(
    _request: Request,
    action: string | undefined
  ): Promise<Response | undefined> {
    if (
      action?.startsWith("coordination-held-") ||
      action?.startsWith("apps-held-")
    ) {
      const kind = action.startsWith("apps-") ? "apps" : "coordination"
      const runner = kind === "apps" ? this.appEvents : this.coordinationRunner
      if (action === `${kind}-held-start`) {
        await this.lifecycle.start()
        const held = new Promise<void>((resolve) => {
          this.releaseRunner = resolve
        })
        const pump = async () => {
          this.runnerHoldEntered = true
          await held
          // Accepted native callbacks still need their actual runtime and SQL.
          await this.actorRuntime.runPromise(this.configurationService.read())
          this.events.push(`${kind}.settled`)
          return undefined
        }
        if (kind === "apps") this.appEvents.host.pump = pump
        else this.coordinationRunner.host.step = pump
        const dispose = runner.dispose.bind(runner)
        runner.dispose = () => {
          this.events.push(`${kind}.close`)
          return dispose()
        }
        await runner.armDiscovery()
      }
      if (action === `${kind}-held-release`) this.releaseRunner?.()
      if (action === `${kind}-held-dispose`) {
        await this.lifecycle.dispose()
        this.events.push("host.dispose")
      }
      return Response.json({
        entered: this.runnerHoldEntered,
        events: this.events,
      })
    }
    return undefined
  }

  private async coordinationProbe(
    _request: Request,
    action: string | undefined
  ): Promise<Response | undefined> {
    const coordinationTurn = "00000000-0000-4000-8000-000000000081"
    if (action === "coordination-start") {
      this.coordinationProbeEnabled = true
      await this.harness.pi()
      this.fixtureRun(
        "CREATE TABLE IF NOT EXISTS coordination_probe (released INTEGER NOT NULL)"
      )
      this.fixtureRun("INSERT INTO coordination_probe VALUES (0)")
      const policy = await this.actorRuntime.runPromise(
        this.accessStore.policy("spawn_agents")
      )
      await this.actorRuntime.runPromise(
        this.accessStore.update("spawn_agents", policy.revision, "allow")
      )
      const faux = fauxProvider({
        provider: "openai",
        models: [{ id: "gpt-6-luna", contextWindow: 65536, maxTokens: 2048 }],
        tokensPerSecond: 1000000,
      })
      this.models.setProvider(faux.provider)
      faux.setResponses(
        Array.from({ length: 60 }, () => async (context, options) => {
          await this.actorRuntime.runPromise(
            this.delegations.request(options!.sessionId!),
            { signal: options?.signal }
          )
          const text = JSON.stringify(context.messages)
          if (
            context.messages.some(
              (message) => message.role === "toolResult" && message.isError
            )
          )
            throw new Error("A coordination probe tool failed")
          const lastInput = JSON.stringify(
            context.messages
              .filter(
                (m) =>
                  m.role === "user" && JSON.stringify(m).includes("provenance")
              )
              .at(-1)
          )
          if (text.includes("You are the delegated child")) {
            while (
              !this.fixtureRows<{ released: number }>(
                "SELECT released FROM coordination_probe"
              )[0]?.released
            ) {
              options?.signal?.throwIfAborted()
              await new Promise((r) => setTimeout(r, 10))
            }
            if (lastInput.includes("Use the private draft"))
              return fauxAssistantMessage(
                "Child conclusion after clarification"
              )
            if (
              !context.messages.some(
                (m) => m.role === "toolResult" && m.toolName === "date"
              )
            )
              return fauxAssistantMessage(
                fauxToolCall(
                  "date",
                  { id: 0 },
                  { id: "child-read-after-parent" }
                ),
                { stopReason: "toolUse" }
              )
            if (
              !context.messages.some(
                (m) => m.role === "toolResult" && m.toolName === "list_agents"
              )
            )
              return fauxAssistantMessage(
                fauxToolCall("list_agents", {}, { id: "child-directory" }),
                { stopReason: "toolUse" }
              )
            if (
              !context.messages.some(
                (m) => m.role === "toolResult" && m.toolName === "send_message"
              )
            )
              return fauxAssistantMessage(
                fauxToolCall(
                  "send_message",
                  {
                    to: { sessionId: coordinationTurn, agentId: "main" },
                    text: "Need clarification",
                  },
                  { id: "child-question" }
                ),
                { stopReason: "toolUse" }
              )
            return fauxAssistantMessage("Awaiting clarification")
          }
          if (text.includes("Need clarification")) {
            const question = this.fixtureRows<{ payload: string }>(
              "SELECT payload FROM agent_messages WHERE json_extract(payload,'$.text')='Need clarification'"
            )[0]
            const message = JSON.parse(question!.payload) as {
              id: string
              from: { sessionId: string; agentId: string }
            }
            if (
              !context.messages.some(
                (m) => m.role === "toolResult" && m.toolName === "send_message"
              )
            )
              return fauxAssistantMessage(
                fauxToolCall(
                  "send_message",
                  {
                    to: message.from,
                    text: "Use the private draft",
                    replyTo: message.id,
                  },
                  { id: "parent-clarification" }
                ),
                { stopReason: "toolUse" }
              )
            return fauxAssistantMessage("Clarification sent")
          }
          if (lastInput.includes("message ID"))
            return fauxAssistantMessage("Received child findings")
          if (context.messages.some((m) => m.role === "toolResult"))
            return fauxAssistantMessage("Parent free while child works")
          return fauxAssistantMessage(
            fauxToolCall(
              "spawn_agents",
              {
                objective: "Collaborate privately",
                tasks: [
                  {
                    name: "Research",
                    task: "Research and ask for clarification",
                    tools: ["date"],
                  },
                ],
              },
              { id: "spawn-collaborator" }
            ),
            { stopReason: "toolUse" }
          )
        })
      )
      const response = await this.authenticatedFetch(
        new Request("https://internal/api/agent/send", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-owner-id": "personal-coordination-owner",
          },
          body: JSON.stringify({
            operationId: coordinationTurn,
            text: "Use a child agent for private research",
            provenance: { author: { kind: "agent", id: "forged" } },
          }),
        })
      )
      return Response.json({
        status: response.status,
        body: await response.text(),
      })
    }
    if (action === "coordination-release") {
      this.fixtureRun("UPDATE coordination_probe SET released=1")
      return Response.json({ ok: true })
    }
    if (action === "coordination-read") {
      const groups = await this.actorRuntime.runPromise(this.delegations.list())
      const root = await this.actorRuntime.runPromise(
        this.conversations.get(coordinationTurn)
      )
      const child = groups[0]?.children[0]
      return Response.json({
        root,
        groups,
        transcript: child
          ? await this.actorRuntime.runPromise(
              this.delegations.transcript(groups[0]!.id, child.id)
            )
          : null,
        turns: await this.actorRuntime.runPromise(this.conversations.recent()),
        tasks: await this.actorRuntime.runPromise(
          localTaskControls(this).list()
        ),
        messages: this.fixtureRows<{ payload: string; state: string }>(
          "SELECT payload,state FROM agent_messages ORDER BY rowid"
        ).map((row) => ({ ...JSON.parse(row.payload), state: row.state })),
        latest:
          root?.session_id &&
          !["failed", "cancelled"].includes(root.status) &&
          child
            ? await this.actorRuntime.runPromise(
                this.coordination.service.lastMessage(Number(root.session_id), {
                  sessionId: coordinationTurn,
                  agentId: String(child.id),
                })
              )
            : null,
      })
    }
    if (action === "coordination-close") {
      await this.actorRuntime.runPromise(
        localTaskControls(this).stop({ kind: "request", id: coordinationTurn })
      )
      await this.actorRuntime.runPromise(this.coordination.pump())
      return Response.json({ ok: true })
    }
    if (action === "coordination-membership-fence") {
      const result = await this.actorRuntime.runPromise(
        Effect.gen({ self: this }, function* () {
          const ids = Array.from(
            { length: 25 },
            (_, n) => `membership-main-${n}`
          )
          for (const [n, id] of ids.entries()) {
            yield* this.conversations.admit(
              {
                operationId: id,
                text: "Retained synthetic history",
              },
              undefined,
              undefined,
              undefined,
              {
                discoveryDeadline: yield* Effect.promise(() =>
                  this.runner.armDiscovery()
                ),
              }
            )
            yield* this.conversations.saveSession(id, String(500000 + n))
            this.fixtureRun(
              "UPDATE chat_turns SET status='done' WHERE id=?",
              id
            )
          }
          yield* this.coordination.store.accept(
            {
              id: "membership-message",
              operationId: "membership-operation",
              from: { sessionId: ids[0]!, agentId: "main" },
              to: { sessionId: ids[24]!, agentId: "main" },
              text: "Queued before membership changed",
              provenance: {
                author: { kind: "agent", id: "synthetic" },
                conversationId: "synthetic",
                recipients: [],
              },
              createdAt: Date.now(),
              deadline: Date.now() + 600000,
            },
            yield* Effect.promise(() => this.coordinationRunner.armDiscovery())
          )
          yield* this.coordination.store.closeAll()
          return {
            closed: yield* Effect.forEach(ids, (id) =>
              this.coordination.store.closed(id)
            ),
            message: (yield* this.coordination.store.get("membership-message"))
              ?.state,
            retained: (yield* this.conversations.get(ids[0]!))?.status,
          }
        })
      )
      return Response.json(result)
    }
    return undefined
  }

  private async memoryWorkProbe(
    _request: Request,
    action: string | undefined
  ): Promise<Response | undefined> {
    if (action?.startsWith("memory-chat-")) {
      await this.lifecycle.start()
      if (action === "memory-chat-start") {
        this.summaryGate = new Promise<void>((resolve) => {
          this.releaseSummary = resolve
        })
        this.maintenanceBackupProbe.held = true
        await this.actorRuntime.runPromise(
          this.memory.append(
            "prior-cost",
            "user",
            "The exact cost is €42.75 🍀. " + "Prior context. ".repeat(45)
          )
        )
        await this.compactor.wake()
        await this.backups.wake()
      }
      if (action === "memory-chat-send") {
        const response = await this.authenticatedFetch(
          new Request("https://internal/api/agent/send", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              operationId: "00000000-0000-4000-8000-000000000031",
              text: "What was the exact cost?",
            }),
          })
        )
        if (!response.ok)
          throw new Error(`Native chat admission failed: ${response.status}`)
        await response.body?.cancel()
      }
      if (action === "memory-chat-release") {
        this.maintenanceBackupProbe.held = false
        this.maintenanceBackupProbe.release?.()
        this.releaseSummary?.()
      }
      const turn = await this.actorRuntime.runPromise(
        this.conversations.get("00000000-0000-4000-8000-000000000031")
      )
      return Response.json({
        summaryEntered: this.summaryEntered,
        backupEntered: this.maintenanceBackupProbe.entered,
        backupHeld: this.maintenanceBackupProbe.held,
        ready: await this.actorRuntime.runPromise(this.memory.settled()),
        turn: turn && {
          status: turn.status,
          answer: turn.answer,
          prompt:
            turn.prompt ??
            (turn.session_id
              ? JSON.stringify(
                  (
                    await (
                      await this.harness.conversation(turn.session_id)
                    ).entries({}, 256, undefined, BACKGROUND_CONTEXT)
                  ).items
                )
              : null),
        },
      })
    }
    if (action === "memory") {
      const jsonl = JSON.stringify({
        kind: "note",
        text: "Native imported 🍀",
        date: "2020-01-02T10:00:00Z",
      })
      const importing = () =>
        this.authenticatedFetch(
          new Request("https://internal/api/agent/import", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonl }),
          })
        )
      const first = await importing(),
        replay = await importing()
      const search = await this.authenticatedFetch(
        new Request(
          "https://internal/api/agent/search?q=" +
            encodeURIComponent("Native imported 🍀")
        )
      )
      const tree = await this.authenticatedFetch(
        new Request("https://internal/api/agent/tree")
      )
      return Response.json({
        firstStatus: first.status,
        first: await first.json(),
        replayStatus: replay.status,
        replay: await replay.json(),
        search: await search.json(),
        tree: await tree.json(),
        memoryTools: [...this.memoryTools.read, this.memoryTools.write].map(
          (tool) => tool.name
        ),
      })
    }
    if (action === "export") {
      const response = await this.authenticatedFetch(
        new Request("https://internal/api/agent/export")
      )
      const text = await response.text()
      const rows = text
        .trim()
        .split("\n")
        .map((row) => JSON.parse(row))
      return Response.json({
        status: response.status,
        cache: response.headers.get("cache-control"),
        contentType: response.headers.get("content-type"),
        header: rows[0],
        footer: rows.at(-1),
        answerPresent: rows.some(
          (row) => row.type === "message" && row.text === "Native actor answer"
        ),
      })
    }

    return undefined
  }
}
