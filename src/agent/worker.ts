import type { Credential } from "@earendil-works/pi-ai"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import {
  createRegistry,
  defineTool,
  Harness,
  type Storage,
  type Tx,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable"
import { PiHarness, openPiSessionStore } from "agents/harness/pi"
import {
  Lifecycle,
  LifecycleCapability,
  type LifecycleJobOutcome,
} from "agents/lifecycle"
import { MCPClientManager } from "agents/mcp/client"
import { DurableObject } from "cloudflare:workers"
import {
  Scheduler,
  Cause,
  Exit,
  Layer,
  ManagedRuntime,
  Redacted,
  Semaphore,
  Scope,
} from "effect"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import "../observability/lifecycle"
import type { AgentEnv } from "../../alchemy.run"
import {
  connectionRequest,
  connectionResponse,
  connectionJson,
  connectionDecode,
} from "../access/adapters/connection-http"
import {
  ConnectionStore,
  sqliteRemoteSelection,
} from "../access/adapters/connections"
import { accessRequest } from "../access/adapters/http"
import { mcpConnectionClient } from "../access/adapters/mcp"
import { ConnectionOAuthProvider } from "../access/adapters/oauth"
import { guardedTools } from "../access/adapters/pi"
import { piRemoteResult } from "../access/adapters/receipt"
import { remoteToolResolution } from "../access/adapters/resolution"
import {
  ConnectionRequest,
  ConnectionResult,
  ConnectionOutcome,
  connectionNative,
  connectionRpc,
} from "../access/adapters/rpc"
import { AccessStore } from "../access/adapters/sqlite"
import {
  RemoteConnections,
  connectionApplication,
} from "../access/connection-service"
import {
  SelectRemoteTools,
  ConnectionError,
  RemoteToolArguments,
  type RemoteTool,
} from "../access/connections"
import { builtInTools, AccessStorageError } from "../access/contracts"
import { AccessGate, type AccessError } from "../access/gate"
import { selectRemoteTools } from "../access/remote-selection"
import {
  ActivityRequest,
  ActivityResult,
  ActivityOutcome,
} from "../activity/adapters/rpc"
import { SqliteActivityRecords } from "../activity/adapters/sqlite"
import type {
  ActivityAgent,
  ActivityQuery,
  ActivitySnapshot,
  ActivityConversation,
} from "../activity/contracts"
import type { RunCursor } from "../activity/run"
import {
  Activity,
  activityApplication,
  activitySource,
  type ActivitySources,
} from "../activity/service"
import { AgentCatalog, AgentId, agentObjectName, homeAgentId } from "../agents"
import { BotConfigurationStore } from "../agents/adapters/configuration"
import { agentCatalogRequest } from "../agents/adapters/http"
import { AgentCatalogHttp, agentCatalogHttp } from "../agents/adapters/http-api"
import {
  AgentRequest,
  AgentResult,
  AgentOutcome,
  type AgentFailure,
  agentRpc,
  agentRpcNative,
} from "../agents/adapters/rpc"
import { sqliteAgentCatalog } from "../agents/adapters/sqlite"
import {
  agentNativeOperation,
  TerminalAuthoritySync,
  terminalAuthoritySyncLayer,
  type synchronizeTerminalAuthority,
  configurationInput,
} from "../agents/adapters/synchronization"
import {
  configureAgent,
  archiveAgent,
  type AgentConfigurationHost,
} from "../agents/application"
import {
  BotConfiguration,
  configurationApplication,
} from "../agents/configuration"
import { type AgentProfile } from "../agents/contracts"
import {
  AgentConflict,
  type AgentStorageError,
  AgentSynchronizationError,
  AgentRuntimeUnavailable,
} from "../agents/domain"
import { webExecutor } from "../apps/adapters/code"
import { appsRequest } from "../apps/adapters/http"
import { appTools } from "../apps/adapters/pi"
import { AppStore } from "../apps/adapters/sqlite"
import { AppStorageError } from "../apps/contracts"
import { appEventPump } from "../apps/pump"
import { Apps, appApplication } from "../apps/service"
import { WebApps } from "../apps/web"
import { CloudflareBrowser } from "../browser/adapters/cloudflare"
import { browserRequest } from "../browser/adapters/http"
import { browserWake } from "../browser/adapters/interop"
import { sqliteBrowserLayer } from "../browser/adapters/sqlite"
import { browserTools } from "../browser/adapters/tools"
import { Browser } from "../browser/browser"
import { BrowserStorageError } from "../browser/repository"
import { communicationRequest } from "../communication/adapters/http"
import { personalCommunication } from "../communication/adapters/personal-agent"
import { isMailboxRequest } from "../communication/adapters/rpc"
import {
  communicationTools,
  communicationInstructions,
} from "../communication/adapters/tools"
import { Communication } from "../communication/communication"
import { webCryptoRecoveryLayer } from "../conversations/adapters/crypto"
import {
  ConversationCheckpoint,
  conversationEvents,
} from "../conversations/adapters/events"
import { admissionResponse } from "../conversations/adapters/http-admission"
import {
  piConversationLayer,
  conversationNativeOperation,
} from "../conversations/adapters/pi-execution"
import { runRecoveryHook } from "../conversations/adapters/pi-recovery"
import {
  sqliteConversationJournal,
  conversationTransactions,
} from "../conversations/adapters/sqlite-journal"
import { RunRecoveryStore } from "../conversations/adapters/sqlite-recovery"
import { ConversationStore } from "../conversations/adapters/sqlite-turns"
import {
  guardedMessageAdmission,
  messageAdmission,
} from "../conversations/admission"
import { retryMessage, stopConversation } from "../conversations/commands"
import {
  CancelInput,
  SendInput,
  type ChatState,
} from "../conversations/contracts"
import {
  ConversationExecution,
  ConversationExecutionError,
} from "../conversations/execution"
import { ConversationJournal } from "../conversations/journal"
import { conversationPump } from "../conversations/pump"
import {
  RunRecovery,
  recoveryApplication,
} from "../conversations/recovery-service"
import type { ConversationError } from "../conversations/service"
import {
  Conversations,
  conversationApplication,
} from "../conversations/service"
import { conversationSnapshot } from "../conversations/snapshot"
import {
  runtimeStatusEffect,
  type RuntimeStatus,
} from "../conversations/status"
import {
  ConversationStorageError,
  ModelSettings,
  type Submission,
  type Turn,
} from "../conversations/turns"
import { backgroundRequest } from "../delegation/adapters/background-http"
import { SqliteBackgroundMailbox } from "../delegation/adapters/background-mailbox"
import {
  BackgroundParentRequest,
  BackgroundParentResult,
  BackgroundParentOutcome,
} from "../delegation/adapters/background-parent"
import { backgroundRemote } from "../delegation/adapters/background-rpc"
import { delegationsRequest } from "../delegation/adapters/http"
import { backgroundNative } from "../delegation/adapters/interop"
import { piDelegationLedger } from "../delegation/adapters/pi"
import {
  delegationTool,
  backgroundTool,
  delegationInstructions,
  childSteeringHook,
} from "../delegation/adapters/tools"
import type { BackgroundHandoff } from "../delegation/background"
import { backgroundObjectName } from "../delegation/background"
import { backgroundCredential } from "../delegation/background-credential"
import { BackgroundMailbox } from "../delegation/background-mailbox"
import {
  BackgroundDelegation,
  backgroundApplication,
} from "../delegation/background-service"
import type { Group } from "../delegation/contracts"
import { DelegationFailure, ReadTool } from "../delegation/contracts"
import type { DelegationSource } from "../delegation/delegation"
import { sharedReference } from "../delegation/delegation"
import { Delegation, delegationApplication } from "../delegation/service"
import { executionRequest } from "../execution/adapters/http"
import { codeService } from "../execution/adapters/service"
import { ExecutionStore } from "../execution/adapters/sqlite"
import { executionTools } from "../execution/adapters/tools"
import { ExecutionStorageError } from "../execution/contracts"
import { Executions, executionApplication } from "../execution/service"
import {
  AccountRequest,
  AccountResult,
  AccountOutcome,
  AccountConnectionOutcome,
  accountConnectionRpc,
  accountRpc,
  accountNative,
  accountToken,
  nativeAccountToken,
} from "../inference/adapters/account-rpc"
import { SqliteCredentials } from "../inference/adapters/credential-sqlite"
import {
  accountCredentials,
  toNativeCredential,
} from "../inference/adapters/credentials-pi"
import { createAgentModels } from "../inference/adapters/models-pi"
import { refreshOAuth } from "../inference/adapters/oauth"
import { openaiCatalogSource } from "../inference/adapters/openai-catalog"
import { ownerCatalogSource } from "../inference/adapters/owner-catalog"
import {
  PiModelStreams,
  piModelStreamsLayer,
  modelCallback,
} from "../inference/adapters/streams-pi"
import { piUsage } from "../inference/adapters/usage-pi"
import { SqliteUsage } from "../inference/adapters/usage-sqlite"
import { ModelCatalogReader, catalogApplication } from "../inference/catalog"
import {
  ModelCredentials,
  credentialApplication,
  type CredentialRefresh,
} from "../inference/credentials"
import type { ModelCatalog } from "../inference/policy"
import {
  ModelUnavailable,
  JobType,
  jobTypes,
  resolveRoute,
  validateRoute,
} from "../inference/policy"
import { InferenceUsage, usageApplication } from "../inference/usage"
import { SqliteBackupStatus } from "../memory/adapters/backup-status"
import { bucketLayer } from "../memory/adapters/bucket"
import { webCryptoLayer } from "../memory/adapters/crypto"
import { memoryWake, memoryImportAuthority } from "../memory/adapters/host"
import {
  exportResponse,
  memoryReadRequest,
  memoryImportResponse,
} from "../memory/adapters/http"
import { SummaryRoutes } from "../memory/adapters/model-routes"
import { piModelSummaryProvider } from "../memory/adapters/pi-model"
import { summaryRetryAuthority } from "../memory/adapters/retry-authority"
import { sqliteMemoryLayer } from "../memory/adapters/sqlite"
import { summaryInput } from "../memory/adapters/summary-input"
import { memoryTools } from "../memory/adapters/tools"
import {
  memoryMaintenance,
  memoryImport,
  runMemoryBackup,
  memoryReport,
  type MemorySchedulingError,
  type MemoryHost,
} from "../memory/application"
import {
  MemoryBackupStatus,
  backupStatusApplication,
} from "../memory/backup-status"
import { Part } from "../memory/domain"
import { ImportInput } from "../memory/import"
import { MemoryTransaction } from "../memory/ledger"
import { MemoryRepository } from "../memory/repository"
import { memorySummaryRetry } from "../memory/retry"
import { SummaryRouting, summaryRoutingApplication } from "../memory/routing"
import {
  summaryApplication,
  type SummaryProvider,
  type SummaryInputs,
} from "../memory/summary-execution"
import { SummaryModel } from "../memory/summary-model"
import { objectsRequest } from "../objects/adapters/http"
import {
  piObjectLedger,
  objectDigest,
  checklistInTransaction,
} from "../objects/adapters/pi"
import {
  objectTools,
  objectContextHook,
  recoverableObjectTools,
} from "../objects/adapters/tools"
import type { ChangeSource } from "../objects/contracts"
import { ObjectFailure } from "../objects/contracts"
import { Objects, objectApplication } from "../objects/service"
import {
  reportInference,
  reportHarness,
  reportRecovery,
} from "../observability/events"
import { WorkerTelemetry } from "../observability/worker"
import { plansRequest } from "../planning/adapters/http"
import {
  piPlanLedger,
  planDigest,
  planBlockerStatus,
} from "../planning/adapters/pi"
import {
  planTools,
  planContextHook,
  planningInstructions,
  recoverablePlanTools,
} from "../planning/adapters/tools"
import { PlanFailure } from "../planning/contracts"
import { planningInputSource } from "../planning/domain"
import { planEvidence } from "../planning/evidence"
import type { PlanSource, PlanControl, PlanEvidence } from "../planning/plans"
import { Planning, planningApplication } from "../planning/service"
import { routinesRequest } from "../routines/adapters/http"
import { routineTools } from "../routines/adapters/pi"
import { sqliteRoutinePersistence } from "../routines/adapters/sqlite"
import { RoutineId } from "../routines/contracts"
import { RoutineStorageError } from "../routines/persistence"
import { routinePump } from "../routines/pump"
import {
  Routines,
  RoutineAuthority,
  type RoutineError,
  routineApplication,
} from "../routines/service"
import { preserveFatal } from "../shared/effect"
import { importSkillsRequest } from "../skills/adapters/hosted"
import {
  readSkillJson,
  skillResponse,
  skillsRequest,
} from "../skills/adapters/http"
import { skillResolution } from "../skills/adapters/resolution"
import {
  SkillReferences,
  ResolvedSkills,
  SkillOutcome,
  skillNative,
  skillRpc,
} from "../skills/adapters/rpc"
import { SkillStore } from "../skills/adapters/sqlite"
import { SelectSkills, SkillConflict } from "../skills/contracts"
import { selectBotSkills } from "../skills/selection"
import { Skills, skillApplication } from "../skills/service"
import { makeDurableObjectSqlite } from "../storage/durable-object"
import { migrateSqlite } from "../storage/migrations"
import { importWorkspaceFile } from "../terminal/adapters/file-import"
import { terminalImports } from "../terminal/adapters/import-service"
import { runCommand } from "../terminal/adapters/service"
import { terminalTools } from "../terminal/adapters/tools"
import { TerminalRuntimeError } from "../terminal/runtime"
import { workspaceFileImport } from "../terminal/workspace-import"
import {
  WebhookAuthorizationRequest,
  WebhookAuthorizationOutcome,
} from "../webhooks/adapters/authorization-rpc"
import { digest } from "../webhooks/adapters/crypto"
import {
  webhookIncoming,
  webhookOwnerRequest,
  webhookNative,
} from "../webhooks/adapters/http"
import { sqliteWebhookPersistence } from "../webhooks/adapters/sqlite"
import { WebhookKey } from "../webhooks/contracts"
import { WebhookStorageError } from "../webhooks/persistence"
import { Webhooks, webhookApplication } from "../webhooks/service"
import { documentService } from "../workspace/adapters/document-service"
import { filesRequest } from "../workspace/adapters/http"
import { workspaceLayer } from "../workspace/adapters/storage"
import { workspaceTools } from "../workspace/adapters/tools"
import { videoService } from "../workspace/adapters/video-service"
import { WorkspaceAdmission } from "../workspace/admission"
import {
  workspaceExtractionCycle,
  workspaceExtractionFailure,
} from "../workspace/application"
import { WorkspaceUnavailable, messageArchiveText } from "../workspace/files"
import { Workspace } from "../workspace/workspace"
import { agentGateway } from "./adapters/gateway"
import { agentJson, agentNative, agentResponse } from "./adapters/http"
import { proxyTerminalRequest } from "./adapters/terminal"
import { agentSettings, contextProjectionBytes } from "./compaction"
import { SYSTEM_PROMPT } from "./prompts"

export { BackgroundGroup } from "../delegation/worker"

class TurnRunner extends LifecycleCapability {
  constructor(
    readonly owner: PersonalAgent,
    readonly capability = "personal-chat"
  ) {
    super(capability)
  }
  async wake() {
    await this.lifecycle.jobs.push({
      id:
        this.capability === "personal-chat"
          ? "pump"
          : `${this.capability}:pump`,
      fn: "pump",
      time: Date.now(),
      singleflight: true,
      hungTimeoutSeconds: 600,
      recoveryLoop: true,
    })
  }
  async onJob(): Promise<LifecycleJobOutcome> {
    try {
      return await this.owner.step()
    } finally {
      this.owner.notifyConversation()
    }
  }
}

class CommunicationRunner extends TurnRunner {
  constructor(owner: PersonalAgent) {
    super(owner, "bot-communication")
  }
  async wake() {
    await this.lifecycle.jobs.push({
      id: "bot-communication:pump",
      fn: "pump",
      time: Date.now() + 1000,
      singleflight: true,
      recoveryLoop: true,
      hungTimeoutSeconds: 30,
    })
  }
  async onJob(): Promise<LifecycleJobOutcome> {
    const next = await this.owner.communication.runtime.runPromise(
      Effect.flatMap(Communication, (app) => app.pump())
    )
    return next === undefined ? undefined : { rescheduleAt: next }
  }
}

class BackgroundRunner extends TurnRunner {
  constructor(owner: PersonalAgent) {
    super(owner, "background-groups")
  }
  async onJob(): Promise<LifecycleJobOutcome> {
    const next = await this.owner.stepBackground()
    return next === undefined ? undefined : { rescheduleAt: next }
  }
}

class AppEventRunner extends TurnRunner {
  constructor(owner: PersonalAgent) {
    super(owner, "app-events")
  }
  async onJob(): Promise<LifecycleJobOutcome> {
    const next = await this.owner.actorRuntime.runPromise(
      this.owner.appPump.run().pipe(Effect.provide(WorkerTelemetry))
    )
    return next === undefined ? undefined : { rescheduleAt: next }
  }
}

class RoutineRunner extends TurnRunner {
  constructor(owner: PersonalAgent) {
    super(owner, "routines")
  }
  async onJob(): Promise<LifecycleJobOutcome> {
    const next = await this.owner.actorRuntime.runPromise(
      this.owner.routinePump.run().pipe(Effect.provide(WorkerTelemetry))
    )
    return next === undefined ? undefined : { rescheduleAt: next }
  }
  async onJobError(): Promise<LifecycleJobOutcome> {
    const next = await this.owner.actorRuntime.runPromise(
      this.owner.routinePump.retry()
    )
    return next === undefined ? undefined : { rescheduleAt: next }
  }
}

class MemoryRunner extends TurnRunner {
  constructor(owner: PersonalAgent) {
    super(owner, "memory-compactor")
  }
  async onJob(): Promise<LifecycleJobOutcome> {
    const next = await this.owner.actorRuntime.runPromise(
      this.owner.memoryMaintenance
        .compact()
        .pipe(Effect.provide(WorkerTelemetry))
    )
    return next === undefined ? undefined : { rescheduleAt: next }
  }
}
class ActorServices extends LifecycleCapability {
  constructor(readonly owner: PersonalAgent) {
    super("effect-services")
  }
  async dispose() {
    // Stop provider admission and accepted account refreshes together: provider
    // waiters must join refresh settlement, which requires its owner to stop too.
    await Effect.runPromise(
      this.owner.actorRuntime
        .runSync(PiModelStreams)
        .shutdown()
        .pipe(
          Effect.exit,
          Effect.zip(
            this.owner.credentialService.shutdown().pipe(Effect.exit),
            { concurrent: true }
          ),
          Effect.flatMap(([streams, credentials]) => {
            if (Exit.isFailure(streams) && Exit.isFailure(credentials))
              return Effect.failCause(
                Cause.combine(streams.cause, credentials.cause)
              )
            if (Exit.isFailure(streams)) return Effect.failCause(streams.cause)
            if (Exit.isFailure(credentials))
              return Effect.failCause(credentials.cause)
            return Effect.void
          }),
          Effect.ensuring(this.owner.communication.runtime.disposeEffect),
          Effect.ensuring(this.owner.actorRuntime.disposeEffect),
          Effect.ensuring(Scope.close(this.owner.storageScope, Exit.void))
        )
    )
  }
}
class BackupRunner extends TurnRunner {
  constructor(owner: PersonalAgent) {
    super(owner, "memory-backups")
  }
  async onJob(): Promise<LifecycleJobOutcome> {
    const next = await this.owner.actorRuntime.runPromise(
      runMemoryBackup(this.owner.backupPrefix()).pipe(
        Effect.provide(WorkerTelemetry)
      )
    )
    return next === undefined ? undefined : { rescheduleAt: next }
  }
}

class ExtractionRunner extends TurnRunner {
  constructor(owner: PersonalAgent) {
    super(owner, "workspace-extraction")
  }
  onJob(): Promise<LifecycleJobOutcome> {
    return this.owner.actorRuntime
      .runPromise(workspaceExtractionCycle())
      .then((next) => (next === undefined ? undefined : { rescheduleAt: next }))
  }
  onJobError(): Promise<LifecycleJobOutcome> {
    return this.owner.actorRuntime
      .runPromise(workspaceExtractionFailure)
      .then((next) => ({ rescheduleAt: next }))
  }
}

class BrowserRunner extends TurnRunner {
  constructor(owner: PersonalAgent) {
    super(owner, "browser-cleanup")
  }
  onJob(): Promise<LifecycleJobOutcome> {
    return this.owner.actorRuntime.runPromise(
      this.owner.browser
        .cleanup()
        .pipe(
          Effect.map((deadline) =>
            deadline === undefined ? undefined : { rescheduleAt: deadline }
          )
        )
        .pipe(Effect.provide(WorkerTelemetry))
    )
  }
}

export class PersonalAgent extends DurableObject<AgentEnv> {
  private run<TValue, TError>(
    program: Effect.Effect<TValue, TError>,
    options?: { signal?: AbortSignal }
  ): Promise<TValue> {
    return this.actorRuntime.runPromise(
      program.pipe(Effect.provide(WorkerTelemetry)),
      options
    )
  }
  get backupBucket() {
    return this.env.MEMORY_BACKUPS
  }
  readonly storageScope = Effect.runSync(Scope.make())
  readonly db = Effect.runSync(
    Effect.gen({ self: this }, function* () {
      const db = yield* makeDurableObjectSqlite(this.ctx.storage)
      yield* migrateSqlite(db)
      return db
    }).pipe(
      Effect.provideService(Scope.Scope, this.storageScope),
      Effect.provideService(Scheduler.PreventSchedulerYield, true)
    )
  )
  private foregroundSizing: Turn | undefined
  private writable<TError>(failure: (cause: unknown) => TError) {
    return this.botConfiguration.read().pipe(
      Effect.map((configuration) => configuration?.status !== "archived"),
      Effect.mapError(failure)
    )
  }
  readonly conversations = new ConversationStore(this.db, {
    model: this.env.MODEL_ID,
    thinking: "medium",
  })
  readonly recovery = new RunRecoveryStore(this.db)
  readonly credentialLedger = new SqliteCredentials(
    this.db,
    Redacted.make(this.env.OPENAI_CREDENTIAL)
  )
  readonly credentials = accountCredentials(async (provider, signal) => {
    return modelCallback(
      this.actorRuntime.runPromiseExit(
        this.modelCredentialProgram(provider).pipe(
          Effect.map((value) => (value ? nativeAccountToken(value) : undefined))
        ),
        { signal }
      )
    )
  })
  readonly connectionStore = new ConnectionStore(this.db)
  readonly mcp = new MCPClientManager("durable-pi", "1.0.0", {
    createAuthProvider: (callbackUrl) =>
      new ConnectionOAuthProvider(
        this.ctx.storage,
        this.connectionStore,
        callbackUrl
      ),
  })
  readonly connectionClient = mcpConnectionClient(this.mcp)
  readonly remoteSelection = sqliteRemoteSelection(this.connectionStore)
  readonly accessStore = new AccessStore(this.db, () =>
    this.connectionStore.selection().pipe(
      Effect.map((selection) => [
        ...builtInTools,
        ...selection.tools.map((tool) => ({
          name: tool.name,
          title: `${tool.connectionName} / ${tool.remoteName}`,
          description: tool.description,
          mode: "ask" as const,
        })),
      ]),
      Effect.mapError(
        (cause) =>
          new AccessStorageError({ operation: "read tool catalog", cause })
      )
    )
  )
  readonly access = new AccessGate(
    this.accessStore,
    (turnId) =>
      Effect.gen({ self: this }, function* () {
        const turn = yield* this.conversations.get(turnId)
        return (
          !!turn &&
          ["queued", "preparing", "running"].includes(turn.status) &&
          (yield* this.recovery.get(turnId))?.view?.phase !== "blocked" &&
          (yield* this.routineAuthority.canRun(turnId)) &&
          (yield* this.botConfiguration.read())?.status !== "archived"
        )
      }).pipe(
        Effect.mapError(
          (cause) =>
            new AccessStorageError({ operation: "read tool authority", cause })
        )
      ),
    () => this.notifyConversation(),
    () => this.ctx.id.toString()
  )
  readonly protectTool = guardedTools(
    this.access,
    (api) =>
      this.delegations.root(Number(api.conversationId)).pipe(
        Effect.flatMap((root) =>
          Effect.gen({ self: this }, function* () {
            if (root) return root
            const turn = yield* this.active()
            return turn?.session_id === String(api.conversationId)
              ? turn.id
              : undefined
          })
        )
      ),
    new Set([
      ...recoverableObjectTools,
      ...recoverablePlanTools,
      "delegate_tasks",
      "background_tasks",
      "delegate_bot",
    ]),
    (program, options) =>
      this.actorRuntime.runPromiseExit(
        program.pipe(Effect.provide(WorkerTelemetry)),
        options
      )
  )
  readonly skills = new SkillStore(this.db)
  readonly botConfiguration = new BotConfigurationStore(this.db)
  readonly apps = new AppStore(this.db, () =>
    this.writable(
      (cause) => new AppStorageError({ operation: "read app authority", cause })
    )
  )
  readonly summaryRoutes = new SummaryRoutes(this.db)
  readonly summaryRoutingLayer = summaryRoutingApplication(this.summaryRoutes)
  readonly summaryInputs: SummaryInputs = {
    settings: () => summaryInput(this.conversationService.jobSetting("memory")),
    catalog: () => summaryInput(this.catalogProgram()),
  }
  readonly backupStatusLedger = new SqliteBackupStatus(this.db)
  private readonly catalogLayer = sqliteAgentCatalog(this.db)
  readonly actorRuntime = ManagedRuntime.make(
    Layer.mergeAll(
      terminalAuthoritySyncLayer(
        this.env.TERMINAL_SERVICE,
        this.ctx.id.toString()
      ),
      usageApplication(new SqliteUsage(this.db), () => crypto.randomUUID()),
      piModelStreamsLayer,
      activityApplication(
        new SqliteActivityRecords(this.db),
        {
          profiles: (): ReturnType<ActivitySources["profiles"]> =>
            activitySource(this.catalog.list()),
          pausedSummaries: (): ReturnType<ActivitySources["pausedSummaries"]> =>
            activitySource(
              this.memory
                .issues()
                .pipe(
                  Effect.map(
                    (issues) =>
                      issues.filter((issue) => issue.retryAt === null).length
                  )
                )
            ),
          backupError: (): ReturnType<ActivitySources["backupError"]> =>
            activitySource(
              this.backupStatus
                .read()
                .pipe(Effect.map((status) => status?.error ?? null))
            ),
          totals: (id): ReturnType<ActivitySources["totals"]> =>
            activitySource(this.inferenceUsage.totals(id)),
        },
        this.ctx.id.toString()
      ),
      backgroundApplication(
        new SqliteBackgroundMailbox(this.db),
        (id) =>
          Effect.gen({ self: this }, function* () {
            const turn = yield* this.conversations.get(id)
            if (
              !turn ||
              (yield* this.botConfiguration.read())?.status === "archived" ||
              ["failed", "cancelled", "stopping"].includes(turn.status) ||
              !(yield* this.routineAuthority.canRun(id))
            )
              return "cancelled" as const
            return turn.status === "done"
              ? ("done" as const)
              : ("active" as const)
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ConversationStorageError({
                  operation: "read background authority",
                  cause,
                })
            )
          ),
        this.ctx.id.toString(),
        () => crypto.randomUUID(),
        backgroundRemote(this.ctx.id.toString(), (id) =>
          this.env.BACKGROUND.getByName(
            backgroundObjectName(this.ctx.id.toString(), id)
          )
        ),
        {
          active: () => this.active().pipe(Effect.map((turn) => !!turn)),
          backgroundActive: () =>
            this.active().pipe(Effect.map((turn) => !!turn?.origin)),
          wakeConversation: () => backgroundNative(() => this.runner.wake()),
          wakeBackground: () =>
            backgroundNative(() => this.backgroundRunner.wake()),
          notify: () => Effect.sync(() => this.notifyConversation()),
          admission: {
            transactionGroup: this.db,
            admit: (handoff, report) =>
              this.conversations
                .admit(
                  {
                    operationId: handoff.reportId,
                    text: report,
                    origin: {
                      kind: "background",
                      groupId: handoff.id,
                      turnId: handoff.turnId,
                    },
                  },
                  undefined,
                  [],
                  handoff.route
                )
                .pipe(Effect.map((admission) => admission.turn.id)),
            stop: (reportId) =>
              this.conversations.requestStop(reportId).pipe(Effect.asVoid),
          },
        }
      ),
      delegationApplication(
        piDelegationLedger(
          () => this.harness.pi(),
          () => this.registry.snapshot().extension("delegated-reader")!,
          () =>
            this.registry.snapshot().extension("delegated-reader")?.tools ?? []
        ),
        {
          current: (id, conversationId) =>
            Effect.gen({ self: this }, function* () {
              const turn = yield* this.conversations.get(id)
              return (
                turn?.status === "running" &&
                turn.session_id === String(conversationId) &&
                (yield* this.routineAuthority.canRun(id)) &&
                (yield* this.botConfiguration.read())?.status !== "archived"
              )
            }).pipe(
              Effect.mapError(
                () =>
                  new DelegationFailure({
                    code: "unavailable",
                    message: "Could not confirm the parent request.",
                  })
              )
            ),
          cancelled: (id) =>
            Effect.gen({ self: this }, function* () {
              return (
                ["stopping", "cancelled", "failed"].includes(
                  (yield* this.conversations.get(id))?.status ?? "cancelled"
                ) ||
                (yield* this.botConfiguration.read())?.status === "archived"
              )
            }).pipe(
              Effect.mapError(
                () =>
                  new DelegationFailure({
                    code: "unavailable",
                    message: "Could not confirm the parent request.",
                  })
              )
            ),
        }
      ),
      credentialApplication(
        this.credentialLedger,
        this.createCredentialRefresher()
      ),
      catalogApplication(
        ownerCatalogSource(
          () =>
            this.configurationService
              .read()
              .pipe(Effect.map((configuration) => configuration?.owner)),
          (owner) => accountRpc(this.env.AGENT.getByName(owner)).catalog(),
          openaiCatalogSource(
            () =>
              this.credentialService.resolve("openai").pipe(
                preserveFatal,
                Effect.mapError(
                  () =>
                    new ModelUnavailable({
                      message:
                        "Reconnect ChatGPT to verify model availability.",
                    })
                ),
                Effect.map((value) =>
                  value ? toNativeCredential(value) : undefined
                )
              ),
            () => openaiProvider().getModels()
          ),
          (owner) => this.ctx.id.equals(this.env.AGENT.idFromName(owner))
        )
      ),
      executionApplication(
        new ExecutionStore(this.db),
        codeService(this.env.EXECUTION_SERVICE),
        () => this.writable(() => new ExecutionStorageError())
      ),
      sqliteBrowserLayer(
        this.db,
        new CloudflareBrowser(this.env.BROWSER),
        () => this.writable(() => new BrowserStorageError()),
        browserWake(() => this.browserCleanup.wake())
      ),
      backupStatusApplication(this.backupStatusLedger),
      this.catalogLayer,
      agentCatalogHttp.pipe(Layer.provide(this.catalogLayer)),
      configurationApplication(this.botConfiguration),
      recoveryApplication(this.recovery).pipe(
        Layer.provide(webCryptoRecoveryLayer)
      ),
      workspaceLayer(
        this.db,
        this.env.WORKSPACE_ASSETS,
        `files/${this.ctx.id.toString()}`,
        () => this.writable(() => new WorkspaceUnavailable()),
        documentService(this.env.DOCUMENT_SERVICE),
        videoService(this.env.TERMINAL_SERVICE, this.ctx.id.toString())
      ),
      Layer.unwrap(
        Effect.map(MemoryTransaction, (memory) =>
          sqliteConversationJournal(this.db, this.conversations, memory)
        )
      ).pipe(Layer.provideMerge(sqliteMemoryLayer(this.db))),
      webCryptoLayer,
      bucketLayer(this.backupBucket),
      summaryApplication(this.summaryInputs, this.createSummaryProvider()).pipe(
        Layer.provideMerge(this.summaryRoutingLayer)
      ),
      conversationApplication(this.conversations),
      piConversationLayer(
        () => this.harness,
        () => this.env.MODEL_ID
      ),
      connectionApplication(this.connectionStore, this.connectionClient),
      appApplication(this.apps),
      skillApplication(this.skills),
      planningApplication(
        piPlanLedger(
          () => this.harness.pi(),
          (tx) => this.transactionPlanEvidence(tx)
        ),
        this.createPlanAuthority(),
        planDigest
      ),
      objectApplication(
        piObjectLedger(() => this.harness.pi()),
        (source) => this.canChangeObject(source),
        objectDigest
      ),
      webhookApplication(() =>
        this.writable(
          (cause) =>
            new WebhookStorageError({
              operation: "read webhook authority",
              cause,
            })
        )
      ).pipe(
        Layer.provide(sqliteWebhookPersistence(this.db)),
        Layer.provideMerge(
          routineApplication(
            () =>
              this.writable(
                (cause) =>
                  new RoutineStorageError({
                    operation: "read routine authority",
                    cause,
                  })
              ),
            () => crypto.randomUUID()
          ).pipe(Layer.provide(sqliteRoutinePersistence(this.db)))
        )
      )
    )
  )
  readonly credentialService: typeof ModelCredentials.Service =
    this.actorRuntime.runSync(ModelCredentials)
  readonly workspaceService: typeof Workspace.Service =
    this.actorRuntime.runSync(Workspace)
  readonly configurationService: typeof BotConfiguration.Service =
    this.actorRuntime.runSync(BotConfiguration)
  readonly recoveryService: typeof RunRecovery.Service =
    this.actorRuntime.runSync(RunRecovery)
  readonly memory: typeof MemoryRepository.Service =
    this.actorRuntime.runSync(MemoryRepository)
  readonly backupStatus: typeof MemoryBackupStatus.Service =
    this.actorRuntime.runSync(MemoryBackupStatus)
  readonly memoryHost: MemoryHost<
    | MemorySchedulingError
    | Effect.Error<ReturnType<typeof this.conversationService.active>>
  > = {
    active: () =>
      this.conversationService.active().pipe(Effect.map((turn) => !!turn)),
    notify: () => Effect.sync(() => this.notifyConversation()),
    wakeCompactor: () =>
      memoryWake("wake compactor", () => this.compactor.wake()),
    wakeBackup: () => memoryWake("wake backup", () => this.backups.wake()),
    wakeConversation: () =>
      memoryWake("wake conversation", () => this.runner.wake()),
  }
  readonly memoryMaintenance = memoryMaintenance(this.memoryHost)
  readonly importMemory = memoryImport(
    this.actorRuntime.runSync(MemoryTransaction),
    memoryImportAuthority(this.db, () =>
      this.conversations.active().pipe(Effect.map((turn) => !!turn))
    ),
    this.memoryHost
  )
  readonly memoryTools = memoryTools(this.memory, (program, signal) =>
    this.run(program, { signal })
  )
  readonly summaryRouting: typeof SummaryRouting.Service =
    this.actorRuntime.runSync(SummaryRouting)
  readonly summaryModel: typeof SummaryModel.Service =
    this.actorRuntime.runSync(SummaryModel)
  readonly skillService: typeof Skills.Service =
    this.actorRuntime.runSync(Skills)
  readonly conversationService: typeof Conversations.Service =
    this.actorRuntime.runSync(Conversations)
  readonly conversationExecution = this.actorRuntime.runSync(
    ConversationExecution
  )
  readonly conversationJournal: typeof ConversationJournal.Service =
    this.actorRuntime.runSync(ConversationJournal)
  readonly connections: typeof RemoteConnections.Service =
    this.actorRuntime.runSync(RemoteConnections)
  readonly appService: typeof Apps.Service = this.actorRuntime.runSync(Apps)
  readonly appPump = appEventPump<
    | Effect.Error<ReturnType<PersonalAgent["modelConnectedProgram"]>>
    | AgentSynchronizationError,
    never
  >(this.appService, {
    active: () =>
      this.configurationService
        .read()
        .pipe(
          Effect.map((configuration) => configuration?.status !== "archived")
        ),
    modelConnected: () => this.modelConnectedProgram(),
    wakeConversation: () =>
      agentNativeOperation("wake conversation", () => this.runner.wake()),
    admission: {
      transactionGroup: this.db,
      admit: (event) =>
        Effect.gen({ self: this }, function* () {
          return (yield* this.conversations.admit(
            { operationId: event.turnId, text: event.text },
            undefined,
            (yield* this.skills.selection().pipe(
              Effect.mapError(
                (cause) =>
                  new ConversationStorageError({
                    operation: "read admission skills",
                    cause,
                  })
              )
            )).skills
          )).turn.id
        }),
    },
    notify: () => Effect.sync(() => this.notifyConversation()),
  })
  readonly catalog: typeof AgentCatalog.Service =
    this.actorRuntime.runSync(AgentCatalog)
  readonly catalogHttp: typeof AgentCatalogHttp.Service =
    this.actorRuntime.runSync(AgentCatalogHttp)
  readonly terminalAuthoritySync = this.actorRuntime.runSync(
    TerminalAuthoritySync
  )
  readonly configurationHost: AgentConfigurationHost<
    | Effect.Error<ReturnType<typeof synchronizeTerminalAuthority>>
    | Effect.Error<ReturnType<Workspace["Service"]["extractionPending"]>>
    | Effect.Error<ReturnType<Apps["Service"]["pending"]>>
    | Effect.Error<ReturnType<Routines["Service"]["nextWake"]>>
  > = {
    invalidateApps: () => Effect.sync(() => this.webApps.invalidate()),
    syncTerminal: (projection) => this.terminalAuthoritySync.sync(projection),
    wakeBrowser: () =>
      agentNativeOperation("wake browser cleanup", () =>
        this.browserCleanup.wake()
      ),
    extractionPending: () => this.workspaceService.extractionPending(),
    wakeExtraction: () =>
      agentNativeOperation("wake extraction", () => this.extraction.wake()),
    appsPending: () =>
      this.appService.pending().pipe(Effect.map((events) => events.length > 0)),
    wakeApps: () =>
      agentNativeOperation("wake app events", () => this.appEvents.wake()),
    routinesPending: () =>
      this.routines.nextWake().pipe(Effect.map((next) => next !== undefined)),
    wakeRoutines: () =>
      agentNativeOperation("wake routines", () => this.routineRunner.wake()),
  }
  readonly synchronizeConfiguration = configureAgent(
    this.configurationService,
    this.configurationHost
  )
  readonly archiveProfile = archiveAgent(this.catalog, (owner, profile) =>
    agentRpcNative(() =>
      agentRpc(
        this.env.AGENT.getByName(agentObjectName(owner, profile.id))
      ).configure(profile.id === homeAgentId ? "" : owner, profile)
    ).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.failCause(
          Cause.map(cause, (error) =>
            error._tag === "AgentRuntimeUnavailable"
              ? new AgentSynchronizationError({
                  operation: "project bot profile",
                })
              : error
          )
        )
      )
    )
  )
  readonly routines: typeof Routines.Service =
    this.actorRuntime.runSync(Routines)
  readonly routineAuthority: typeof RoutineAuthority.Service =
    this.actorRuntime.runSync(RoutineAuthority)
  readonly webhooks: typeof Webhooks.Service =
    this.actorRuntime.runSync(Webhooks)
  readonly messageCommit = guardedMessageAdmission(
    this.conversations,
    this.botConfiguration,
    this.actorRuntime.runSync(WorkspaceAdmission),
    this.skills,
    conversationTransactions(this.db)
  )
  readonly messageAdmission = messageAdmission<
    ConversationExecutionError | AgentConflict | AgentStorageError,
    never
  >(this.conversationService, this.workspaceService, this.messageCommit, {
    connected: () => this.conversationConnected(),
    archived: () =>
      this.configurationService
        .read()
        .pipe(
          Effect.map((configuration) => configuration?.status === "archived")
        ),
    catalog: () => this.catalogProgram(),
    wake: () =>
      conversationNativeOperation("wake conversation", () =>
        this.runner.wake()
      ),
    notify: () => Effect.sync(() => this.notifyConversation()),
  })
  readonly retryMessage = retryMessage(
    this.conversationService,
    this.messageAdmission
  )
  readonly stopConversation = stopConversation(this.conversationService, {
    wake: () =>
      conversationNativeOperation("wake conversation", () =>
        this.runner.wake()
      ),
    wakeBackground: () =>
      conversationNativeOperation("wake background work", () =>
        this.backgroundRunner.wake()
      ),
    notify: () => Effect.sync(() => this.notifyConversation()),
  })
  readonly retrySummary = memorySummaryRetry(
    this.actorRuntime.runSync(MemoryTransaction),
    summaryRetryAuthority(this.botConfiguration),
    this.summaryRoutes,
    this.conversationService,
    {
      catalog: () => this.catalogProgram(),
      wake: () =>
        conversationNativeOperation("wake memory compaction", () =>
          this.compactor.wake()
        ),
      notify: () => Effect.sync(() => this.notifyConversation()),
    }
  )
  private webhookAuthorizationProgram(id: string, key: string) {
    if (!Schema.is(RoutineId)(id) || !Schema.is(WebhookKey)(key))
      return Effect.succeed(false)
    return Effect.gen({ self: this }, function* () {
      const hash = yield* Effect.promise(() => digest(key))
      return yield* this.webhooks.authorized(id, hash)
    })
  }
  async webhookAuthorized(id: string, key: string): Promise<boolean> {
    return modelCallback(
      this.actorRuntime.runPromiseExit(
        this.webhookAuthorizationProgram(id, key)
      )
    )
  }
  async webhookAuthorizationV1(raw: unknown): Promise<Schema.Json> {
    const work = this.actorRuntime.runPromiseExit(
      Effect.gen({ self: this }, function* () {
        yield* Effect.yieldNow
        const request = Schema.decodeUnknownSync(WebhookAuthorizationRequest)(
          raw
        )
        return yield* this.webhookAuthorizationProgram(request.id, request.key)
      }).pipe(Effect.provide(WorkerTelemetry))
    )
    this.ctx.waitUntil(work)
    const exit = await work
    if (Exit.isFailure(exit) && WebhookAuthorizationOutcome.isUnexpected(exit))
      reportHarness(exit.cause, "personal")
    return WebhookAuthorizationOutcome.encode(exit)
  }
  readonly routinePump = routinePump<
    | Effect.Error<ReturnType<PersonalAgent["modelConnectedProgram"]>>
    | AgentSynchronizationError
    | ConversationError
    | AccessError
  >(this.routines, {
    getTurn: (id) => this.conversations.get(id),
    modelConnected: () => this.modelConnectedProgram(),
    wakeConversation: () =>
      agentNativeOperation("wake conversation", () => this.runner.wake()),
    admission: {
      transactionGroup: this.db,
      admit: (run) =>
        Effect.gen({ self: this }, function* () {
          return (yield* this.conversations.admit(
            {
              operationId: run.turnId,
              text: `Routine: ${run.title}\n${run.trigger === "manual" ? "Requested now" : run.trigger === "webhook" ? "Triggered by an external event" : "Scheduled for " + new Date(run.scheduledAt).toISOString()}\n\n${run.prompt}\n\nThis run has a ten-minute budget. Follow the bot's current tool permissions; wait for any required approval. Report the useful result or a concrete failure in this conversation.`,
            },
            undefined,
            (yield* this.skills.selection().pipe(
              Effect.mapError(
                (cause) =>
                  new ConversationStorageError({
                    operation: "read admission skills",
                    cause,
                  })
              )
            )).skills
          )).turn.id
        }),
    },
    stop: (id) =>
      Effect.gen({ self: this }, function* () {
        yield* this.conversations.requestStop(id)
        yield* this.accessStore.cancel(id)
        this.access.notify()
      }),
    notify: () => Effect.sync(() => this.notifyConversation()),
  })
  readonly objects: typeof Objects.Service = this.actorRuntime.runSync(Objects)
  canChangeObject(source: ChangeSource) {
    return Effect.gen({ self: this }, function* () {
      if ((yield* this.botConfiguration.read())?.status === "archived")
        return false
      if (source.actor === "user") return true
      const turn = source.turnId
        ? yield* this.conversations.get(source.turnId)
        : undefined
      return (
        !!turn &&
        (yield* this.active())?.id === turn.id &&
        ["preparing", "running"].includes(turn.status) &&
        (yield* this.routineAuthority.canRun(turn.id))
      )
    }).pipe(
      Effect.mapError(
        () =>
          new ObjectFailure({
            code: "unavailable",
            message: "Could not confirm the current request.",
          })
      )
    )
  }
  planSource(
    turnId: string
  ): Effect.Effect<PlanSource | undefined, PlanFailure> {
    return Effect.gen({ self: this }, function* () {
      const turn = yield* this.conversations.get(turnId)
      if (
        !turn ||
        turn.parent_id ||
        (yield* this.active())?.id !== turn.id ||
        !["preparing", "running"].includes(turn.status) ||
        (yield* this.botConfiguration.read())?.status === "archived" ||
        !(yield* this.routineAuthority.canRun(turn.id))
      )
        return
      const members = yield* this.conversations.members(turnId, false)
      return planningInputSource(
        turnId,
        turn.revision,
        members.map((member) => ({
          id: member.id,
          steering: !!member.parent_id,
          text: member.text,
          hasAttachments: member.attachments.length > 0,
          delivery: member.delivery,
        }))
      )
    }).pipe(
      Effect.mapError(
        () =>
          new PlanFailure({
            code: "unavailable",
            message: "Could not confirm the current request.",
          })
      )
    )
  }
  planningSource(conversationId: string) {
    return this.active().pipe(
      Effect.mapError(
        () =>
          new PlanFailure({
            code: "unavailable",
            message: "Could not confirm the current request.",
          })
      ),
      Effect.flatMap((turn) =>
        turn?.session_id === conversationId
          ? this.planSource(turn.id)
          : Effect.succeed(undefined)
      )
    )
  }
  readonly executions: typeof Executions.Service =
    this.actorRuntime.runSync(Executions)
  readonly plans: typeof Planning.Service = this.actorRuntime.runSync(Planning)
  createPlanAuthority(): PlanControl {
    return {
      current: (id) => this.planSource(id),
      cancelled: (id) =>
        this.conversations.get(id).pipe(
          Effect.map((turn) =>
            ["stopping", "cancelled"].includes(turn?.status ?? "")
          ),
          Effect.mapError(
            () =>
              new PlanFailure({
                code: "unavailable",
                message: "Could not confirm the current request.",
              })
          )
        ),
      receipts: (roots) =>
        this.accessStore.receipts(roots).pipe(
          Effect.map((refs) =>
            refs.map((ref) => ({ ...ref, kind: "receipt" as const }))
          ),
          Effect.mapError(
            () =>
              new PlanFailure({
                code: "unavailable",
                message: "Could not read execution receipts.",
              })
          )
        ),
    }
  }
  transactionPlanEvidence(tx: Tx): PlanEvidence {
    return planEvidence({
      receipt: (query) => this.access.receipt(query),
      execution: (id) => this.executions.get(id),
      app: (id) => this.appService.get(id),
      object: (id) => checklistInTransaction(tx, id),
      files: () => this.workspaceService.list(),
    })
  }
  delegationSource(
    api: ToolExecutionApi
  ): Effect.Effect<DelegationSource, DelegationFailure> {
    return Effect.gen({ self: this }, function* () {
      const receipt = yield* this.accessStore.get(String(api.taskId)),
        turn = receipt
          ? yield* this.conversations.get(receipt.turnId)
          : undefined
      if (
        !turn?.routing ||
        turn.origin ||
        turn.session_id !== String(api.conversationId)
      )
        return yield* new DelegationFailure({
          code: "cancelled",
          message:
            "Delegation must belong to an original active request, not a background report.",
        })
      return {
        turnId: turn.id,
        conversationId: Number(api.conversationId),
        taskId: Number(api.taskId),
        route: turn.routing,
        memory:
          sharedReference(turn.prompt ?? "") +
          "\n" +
          messageArchiveText("", turn.attachments),
      }
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof DelegationFailure
          ? cause
          : new DelegationFailure({
              code: "unavailable",
              message: "Could not confirm the current request.",
            })
      )
    )
  }
  readonly communication = personalCommunication(this, this.env.AGENT)
  readonly backgroundMailbox: typeof BackgroundMailbox.Service =
    this.actorRuntime.runSync(BackgroundMailbox)
  readonly background: typeof BackgroundDelegation.Service =
    this.actorRuntime.runSync(BackgroundDelegation)
  backgroundAuthorized(id: number): Promise<boolean> {
    return this.run(this.background.authorized(id))
  }
  backgroundHandoff(id: number): Promise<BackgroundHandoff> {
    return this.run(this.background.handoff(id))
  }
  async backgroundCredential(
    id: number,
    provider: string
  ): Promise<Credential | undefined> {
    return modelCallback(
      this.actorRuntime.runPromiseExit(
        this.backgroundCredentialProgram(id, provider).pipe(
          Effect.map((value) => (value ? nativeAccountToken(value) : undefined))
        )
      )
    )
  }
  private backgroundCredentialProgram(id: number, provider: string) {
    return backgroundCredential(
      (group) => this.background.authorized(group),
      (selected) => this.modelCredentialProgram(selected)
    )(id, provider)
  }
  async backgroundParentV1(raw: unknown): Promise<Schema.Json> {
    const exit = await this.actorRuntime.runPromiseExit(
      Effect.suspend<typeof BackgroundParentResult.Type, unknown, never>(() => {
        const request = Schema.decodeUnknownSync(BackgroundParentRequest)(raw)
        switch (request._tag) {
          case "Authorized":
            return this.background.authorized(request.id)
          case "Handoff":
            return this.background.handoff(request.id)
          case "Credential":
            return this.backgroundCredentialProgram(
              request.id,
              request.provider
            )
        }
      }).pipe(
        Effect.map(
          Schema.decodeUnknownSync(Schema.toType(BackgroundParentResult))
        )
      )
    )
    if (Exit.isFailure(exit) && BackgroundParentOutcome.isUnexpected(exit))
      reportHarness(exit.cause, "personal")
    return BackgroundParentOutcome.encode(exit)
  }
  async backgroundView(id: number): Promise<Group> {
    return this.run(this.background.read(id))
  }
  async stepBackground() {
    return this.run(this.background.step())
  }
  readonly delegations: typeof Delegation.Service =
    this.actorRuntime.runSync(Delegation)

  readonly browser: typeof Browser.Service = this.actorRuntime.runSync(Browser)
  readonly copyWorkspaceFile = workspaceFileImport(
    this.workspaceService,
    terminalImports(this.env.TERMINAL_SERVICE, this.ctx.id.toString()),
    () =>
      this.configurationService.read().pipe(
        preserveFatal,
        Effect.mapError(
          (cause) =>
            new TerminalRuntimeError({
              operation: "read import authority",
              cause,
            })
        ),
        Effect.map((configuration) => configuration?.status !== "archived")
      )
  )
  readonly uploadLock = Semaphore.makeUnsafe(1)
  readonly downloadLock = Semaphore.makeUnsafe(4)
  readonly inferenceUsage: typeof InferenceUsage.Service =
    this.actorRuntime.runSync(InferenceUsage)
  readonly observeInference = piUsage(
    this.inferenceUsage,
    (work) => modelCallback(this.actorRuntime.runPromiseExit(work)),
    (attempt) => reportInference(attempt, this.ctx.id.toString())
  )
  readonly catalogService: typeof ModelCatalogReader.Service =
    this.actorRuntime.runSync(ModelCatalogReader)
  protected catalogProgram() {
    return this.catalogService.read()
  }
  async accountModelCatalog(): Promise<ModelCatalog> {
    return this.run(this.catalogProgram())
  }
  private modelCredentialProgram(provider: string) {
    return Effect.gen({ self: this }, function* () {
      const owner = (yield* this.configurationService.read())?.owner
      if (owner)
        return yield* accountNative(() =>
          accountRpc(this.env.AGENT.getByName(owner)).credential(provider)
        )
      return yield* this.accountCredentialProgram(provider)
    })
  }
  private accountCredentialProgram(provider: string) {
    // This endpoint is the account authority. It must resolve locally even when
    // that account's bot configuration names the same owner/object.
    return this.credentialService
      .resolve(provider)
      .pipe(
        Effect.map((value) =>
          value?.type === "oauth" ? accountToken(value) : null
        )
      )
  }
  async accountV1(raw: unknown): Promise<Schema.Json> {
    const exit = await this.actorRuntime.runPromiseExit(
      Effect.suspend<typeof AccountResult.Type, unknown, never>(() => {
        const request = Schema.decodeUnknownSync(AccountRequest)(raw)
        switch (request._tag) {
          case "Credential":
            return this.accountCredentialProgram(request.provider)
          case "Catalog":
            return this.catalogProgram()
        }
      }).pipe(
        Effect.map(Schema.decodeUnknownSync(Schema.toType(AccountResult)))
      )
    )
    if (Exit.isFailure(exit) && AccountOutcome.isUnexpected(exit))
      reportHarness(exit.cause, "personal")
    return AccountOutcome.encode(exit)
  }

  communicationFloor() {
    const pins = this.communication.pi.pins()
    if (!pins.length) return undefined
    const windows = pins
      .map((pin) => pin.route.contextWindow)
      .filter((window): window is number => window !== undefined)
    const foreground = this.foregroundSizing?.routing?.contextWindow
    if (foreground !== undefined) windows.push(foreground)
    return windows.length ? Math.min(...windows) : undefined
  }
  contextProjectionBytes() {
    const turn = this.foregroundSizing
    const model = this.models.getModel(
      "openai",
      turn?.model ?? this.env.MODEL_ID
    )
    if (!model) throw new Error("The selected model is unavailable")
    return contextProjectionBytes(
      Math.min(
        model.contextWindow,
        turn?.routing?.contextWindow ?? model.contextWindow,
        this.communicationFloor() ?? model.contextWindow
      )
    )
  }
  readonly models = createAgentModels(this.credentials, {
    start: (request) =>
      this.actorRuntime.runSync(
        Effect.flatMap(PiModelStreams, (streams) => streams.start(request))
      ),
    botId: () => this.ctx.id.toString(),
    waitUntil: (work) => this.ctx.waitUntil(work),
    beforeRequest: (id, signal) =>
      modelCallback(
        this.actorRuntime.runPromiseExit(
          Effect.gen({ self: this }, function* () {
            if (!(yield* this.communication.pi.request(id)))
              yield* this.delegations.request(id)
          }),
          { signal }
        )
      ),
    catalog: (signal) =>
      modelCallback(
        this.actorRuntime.runPromiseExit(this.catalogProgram(), { signal })
      ),
    workingContextFloor: () => this.communicationFloor(),
    contextWindow: (model) => {
      const turn = this.foregroundSizing
      return turn?.model === model ? turn.routing?.contextWindow : undefined
    },
    onAttempt: async (model, thinking, purpose, provider) => {
      const pin = this.communication.pi.pin(provider)
      if (pin)
        return this.observeInference(
          { ...pin.route, model, thinking },
          null,
          `bot task ${pin.taskId} (${purpose})`
        )
      const turn =
        purpose === "memory" ? undefined : await this.run(this.active())
      const route =
        turn?.routing ??
        resolveRoute(purpose === "memory" ? "memory" : "conversation", {
          model,
          thinking,
        })
      return this.observeInference(
        { ...route, model, thinking },
        turn?.id ?? null,
        purpose
      )
    },
    cacheKey: `pi-${this.ctx.id.toString()}`,
  })
  protected createCredentialRefresher(): CredentialRefresh {
    return refreshOAuth
  }
  protected createSummaryProvider(): SummaryProvider {
    return piModelSummaryProvider(
      {
        credentials: () => this.credentials,
        options: (route, job) => ({
          start: (request) =>
            this.actorRuntime.runSync(
              Effect.flatMap(PiModelStreams, (streams) =>
                streams.start(request)
              )
            ),
          botId: () => this.ctx.id.toString(),
          waitUntil: (work) => this.ctx.waitUntil(work),
          contextWindow: () => route.contextWindow,
          cacheKey: `pi-${this.ctx.id.toString()}`,
          onAttempt: () =>
            this.observeInference(
              route,
              null,
              `memory ${job.start}+${job.count}`
            ),
        }),
        systemPrompt: SYSTEM_PROMPT,
        tools: () =>
          this.registry
            .snapshot()
            .tools()
            .map(({ tool }) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
      },
      this.summaryInputs.catalog
    )
  }
  readonly registry = createRegistry()
  private piStorage?: Storage
  readonly harness: PiHarness = new PiHarness({
    coordinateStorage: this.db.coordinatePi,
    harness: async ({ storage, context }) => {
      this.piStorage = storage
      await this.run(this.active())
      this.installRemoteTools(
        (await this.run(this.connectionStore.selection())).tools
      )
      this.registry.install({
        name: "personal",
        hooks: [
          runRecoveryHook({
            storage,
            store: this.recovery,
            application: this.recoveryService,
            run: (program, options) => this.run(program, options),
            access: this.accessStore,
            source: (api) =>
              Effect.gen({ self: this }, function* () {
                const turn = yield* this.active()
                if (
                  !turn ||
                  turn.session_id !== String(api.conversationId) ||
                  !(yield* this.planSource(turn.id))
                )
                  return
                const input = (yield* this.conversations.members(
                  turn.id,
                  false
                )).at(-1)!
                return {
                  turnId: turn.id,
                  steeringKey: JSON.stringify({
                    text: input.text.trim().replace(/\s+/g, " "),
                    files: input.attachments.map((file) => file.id),
                  }),
                }
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ConversationStorageError({
                      operation: "read recovery authority",
                      cause,
                    })
                )
              ),
            stop: async (api, callContext) => {
              const pi = await this.harness.pi()
              const conversation = await pi.conversation(
                api.conversationId,
                callContext
              )
              await conversation?.abort(callContext)
            },
            observed: (runId, view) =>
              reportRecovery(runId, view, this.ctx.id.toString()),
            changed: () => this.notifyConversation(),
          }),
          objectContextHook(
            this.objects,
            () => this.contextProjectionBytes(),
            (operation, signal) => this.run(operation, { signal })
          ),
          planContextHook(
            this.plans,
            (api) => this.planningSource(String(api.conversationId)),
            () => Effect.sync(() => this.contextProjectionBytes()),
            (operation, signal) => this.run(operation, { signal })
          ),
        ],
        sections: [
          { key: "preamble", render: () => SYSTEM_PROMPT, tag: false },
          {
            key: "communication",
            render: () => communicationInstructions,
            tag: false,
          },
          { key: "planning", render: () => planningInstructions, tag: false },
          {
            key: "delegation",
            render: () => delegationInstructions,
            tag: false,
          },
        ],
        tools: [
          ...communicationTools(
            this.communication.runtime.runSync(Communication),
            (api) => {
              return this.delegationSource(api).pipe(
                Effect.map((source) => ({
                  turnId: source.turnId,
                  toolId: String(api.taskId),
                }))
              )
            },
            (operation, signal) =>
              this.communication.runtime.runPromise(operation, { signal })
          ),
          backgroundTool(
            (input, api) =>
              this.delegationSource(api).pipe(
                Effect.flatMap((source) =>
                  this.background.create(input, source)
                )
              ),
            (work, signal) => this.run(work, { signal })
          ),
          delegationTool(
            this.delegations,
            (api) => this.delegationSource(api),
            (work, signal) => this.run(work, { signal })
          ),
          ...planTools(
            this.plans,
            (api) =>
              Effect.gen({ self: this }, function* () {
                const receipt = yield* this.accessStore.get(String(api.taskId)),
                  source = receipt
                    ? yield* this.planSource(receipt.turnId)
                    : undefined
                if (
                  !source ||
                  (yield* this.conversations.get(source.turnId))?.session_id !==
                    String(api.conversationId)
                )
                  return yield* new PlanFailure({
                    code: "cancelled",
                    message: "This tool no longer belongs to an active run.",
                  })
                return source
              }).pipe(
                Effect.mapError((cause) =>
                  cause instanceof PlanFailure
                    ? cause
                    : new PlanFailure({
                        code: "unavailable",
                        message: "Could not confirm the current request.",
                      })
                )
              ),
            (operation, signal) => this.run(operation, { signal })
          ),
          ...objectTools(
            this.objects,
            (api) =>
              Effect.gen({ self: this }, function* () {
                const receipt = yield* this.accessStore.get(String(api.taskId)),
                  turn = receipt
                    ? yield* this.conversations.get(receipt.turnId)
                    : undefined
                if (!turn || turn.session_id !== String(api.conversationId))
                  return yield* new ObjectFailure({
                    code: "read_only",
                    message:
                      "This tool no longer belongs to the active conversation.",
                  })
                return {
                  actor: "agent" as const,
                  surface: "tool" as const,
                  turnId: turn.id,
                  toolCallId: api.callId,
                }
              }).pipe(
                Effect.mapError((cause) =>
                  cause instanceof ObjectFailure
                    ? cause
                    : new ObjectFailure({
                        code: "unavailable",
                        message: "Could not confirm the current request.",
                      })
                )
              ),
            (operation, signal) => this.run(operation, { signal })
          ),
          ...appTools(this.appService, (operation, signal) =>
            this.run(operation, { signal })
          ),
          ...routineTools(
            this.routines,
            () => this.routineRunner.wake(),
            (operation, signal) => this.run(operation, { signal })
          ),
          ...workspaceTools(this.workspaceService, (program, signal) =>
            this.run(program, { signal })
          ),
          ...this.memoryTools.read,
          ...terminalTools(
            (input) =>
              runCommand(
                this.env.TERMINAL_SERVICE,
                this.ctx.id.toString(),
                input
              ),
            (program, options) => this.run(program, options)
          ),
          ...executionTools(this.executions, (program, options) =>
            this.run(program, options)
          ),
          ...browserTools(this.browser, (program, options) =>
            this.run(program, options)
          ),
          this.memoryTools.write,
        ].map(this.protectTool),
      })
      this.registry.install({
        name: "delegated-reader",
        hooks: [
          childSteeringHook(
            this.delegations,
            (id) =>
              this.conversations.members(id).pipe(
                Effect.map((members) =>
                  members
                    .filter((member) => member.parent_id)
                    .map((member) => ({
                      id: member.id,
                      text:
                        member.text ||
                        "New attachments were supplied to the parent. Do not infer their contents; the parent must reconcile them.",
                    }))
                ),
                Effect.mapError(
                  () =>
                    new DelegationFailure({
                      code: "unavailable",
                      message: "Could not read parent steering.",
                    })
                )
              ),
            (work, signal) => this.run(work, { signal })
          ),
        ],
        tools: this.registry
          .snapshot()
          .extension("personal")!
          .tools!.filter((tool) => Schema.is(ReadTool)(tool.name)),
      })
      const harness = await Harness.open(
        storage,
        {
          models: this.models,
          registry: this.registry,
          settings: agentSettings(() => {
            const turn = this.foregroundSizing
            const model = this.models.getModel(
              "openai",
              turn?.model ?? this.env.MODEL_ID
            )
            return model
              ? {
                  ...model,
                  maxTokens: Math.max(
                    model.maxTokens,
                    ...this.communication.pi
                      .pins()
                      .map(
                        (pin) =>
                          this.models.getModel("openai", pin.route.model)
                            ?.maxTokens ?? 0
                      )
                  ),
                  contextWindow: Math.min(
                    model.contextWindow,
                    turn?.routing?.contextWindow ?? model.contextWindow
                  ),
                }
              : undefined
          }),
          onReport: (error) => reportHarness(error, "personal"),
        },
        context
      )
      await this.run(this.communication.pi.restore(harness))
      return harness
    },
    defaults: {
      model: { provider: "openai", id: this.env.MODEL_ID },
      thinkingLevel: "medium",
    },
  })
  readonly communicationRunner = new CommunicationRunner(this)
  readonly conversationPump = conversationPump<
    | ConversationExecutionError
    | PlanFailure
    | DelegationFailure
    | AccessError
    | RoutineError
    | ConversationStorageError
    | AgentConflict
    | AgentStorageError,
    never
  >(
    this.conversationService,
    this.memory,
    this.conversationJournal,
    this.conversationExecution,
    {
      canRun: (id) => this.routines.canRun(id),
      instructions: () =>
        this.configurationService
          .read()
          .pipe(
            Effect.map((configuration) => configuration?.instructions ?? "")
          ),
      recovery: (id) =>
        this.recoveryService
          .get(id)
          .pipe(Effect.map((state) => state?.view ?? undefined)),
      cancelAccess: (id) => this.access.cancel(id),
      awaitingAccess: () =>
        this.access.pending().pipe(Effect.map((pending) => pending.length > 0)),
      cancelPlan: (id) => this.plans.cancel(id),
      reconcileDelegation: (id) => this.delegations.reconcile(id),
      wakeCompaction: () =>
        conversationNativeOperation("wake compaction", () =>
          this.compactor.wake()
        ),
      wakeBackup: () =>
        conversationNativeOperation("wake backup", () => this.backups.wake()),
      wakeBackground: () =>
        conversationNativeOperation("wake background", () =>
          this.backgroundRunner.wake()
        ),
      notify: () => Effect.sync(() => this.notifyConversation()),
      completed: (turn, failed, recovery) =>
        this.inferenceUsage.totals(turn.id).pipe(
          Effect.flatMap((totals) =>
            (failed && turn.status !== "stopping"
              ? Effect.logError("Conversation.runFailed")
              : Effect.logInfo("Conversation.runFinished")
            ).pipe(
              Effect.annotateLogs({
                event: "conversation.finished",
                botId: this.ctx.id.toString(),
                sessionId: turn.session_id,
                runId: turn.id,
                ...totals,
                outcome:
                  turn.status === "stopping"
                    ? "cancelled"
                    : failed
                      ? "failed"
                      : "completed",
                recovery: recovery?.phase ?? "none",
              })
            )
          ),
          preserveFatal,
          Effect.catchTag("UsageStorageError", () =>
            Effect.logWarning("Conversation.completionUsageUnavailable")
          )
        ),
    }
  )
  readonly backgroundRunner = new BackgroundRunner(this)
  readonly runtimeStatusProgram = runtimeStatusEffect<
    AgentConflict | AgentStorageError | AccessError,
    never
  >(this.conversationService, {
    archived: () =>
      this.configurationService
        .read()
        .pipe(
          Effect.map((configuration) => configuration?.status === "archived")
        ),
    awaitingApproval: (id) => this.access.awaitingApproval(id),
    planBlocked: (id) =>
      planBlockerStatus(
        () => this.piStorage,
        async () =>
          this.db.coordinatePi(
            await this.run(
              this.db.use(() =>
                Effect.promise(() => openPiSessionStore(this.ctx.storage))
              )
            )
          ),
        id
      ).pipe(
        preserveFatal,
        Effect.match({
          onSuccess: (blocked) => blocked,
          onFailure: () => undefined,
        })
      ),
  })
  readonly snapshotProgram = conversationSnapshot(
    this.conversationService,
    this.conversationExecution,
    this.conversationJournal,
    () => this.snapshotMetadata()
  )
  readonly runner = new TurnRunner(this)
  readonly compactor = new MemoryRunner(this)
  readonly backups = new BackupRunner(this)
  readonly extraction = new ExtractionRunner(this)
  readonly browserCleanup = new BrowserRunner(this)
  readonly webApps = new WebApps(
    this.appService,
    webExecutor(this.env.EXECUTION_SERVICE)
  )
  readonly appEvents = new AppEventRunner(this)
  readonly routineRunner = new RoutineRunner(this)
  readonly actorServices = new ActorServices(this)
  readonly lifecycle = Lifecycle.install(this)
    .use(this.mcp)
    .use(this.harness)
    .use(this.runner)
    .use(this.backgroundRunner)
    .use(this.communicationRunner)
    .use(this.compactor)
    .use(this.backups)
    .use(this.extraction)
    .use(this.browserCleanup)
    .use(this.appEvents)
    .use(this.routineRunner)
    .use(this.actorServices)

  private readonly conversationCheckpoint = new ConversationCheckpoint()
  private readonly conversationListeners = new Set<() => void>()
  notifyConversation() {
    for (const listener of this.conversationListeners) listener()
  }

  async onStart() {
    if ((await this.run(this.communication.mailbox.nextWake())) !== undefined)
      await this.communicationRunner.wake()
    await this.backgroundRunner.wake()
    if ((await this.run(this.routineAuthority.nextWake())) !== undefined)
      await this.routineRunner.wake()
    if ((await this.run(this.apps.pending())).length)
      await this.appEvents.wake()
    await this.run(this.executions.recover())
    await this.run(this.browser.recover())
    if (await this.run(this.browser.maintenancePending()))
      await this.browserCleanup.wake()
    if (await this.run(this.workspaceService.extractionPending()))
      await this.extraction.wake()
    if (await this.run(this.active())) await this.runner.wake()
    await this.actorRuntime.runPromise(
      this.memoryMaintenance.recover().pipe(Effect.provide(WorkerTelemetry))
    )
  }
  backupPrefix() {
    return `memory/${this.ctx.id.toString()}`
  }
  active() {
    return this.conversations.active().pipe(
      Effect.tap((turn) =>
        Effect.sync(() => {
          this.foregroundSizing = turn
        })
      )
    )
  }
  installRemoteTools(tools: readonly RemoteTool[]) {
    this.registry.install({
      name: "connections",
      tools: tools.map((tool) =>
        this.protectTool(
          defineTool({
            name: tool.name,
            description: `${tool.connectionName} / ${tool.remoteName}: ${tool.description}`,
            parameters: tool.parameters,
            replay: "unsafe",
            execute: (args, _api, context) =>
              modelCallback(
                this.actorRuntime.runPromiseExit(
                  Effect.gen({ self: this }, function* () {
                    yield* Effect.yieldNow
                    if (
                      !(yield* this.remoteSelection.selection()).tools.some(
                        (value) => value.name === tool.name
                      )
                    )
                      return yield* new ConnectionError({
                        message:
                          "This tool was removed from the bot. Do not retry it.",
                      })
                    const owner = (yield* this.configurationService.read())
                      ?.owner
                    const input = yield* Schema.decodeUnknownEffect(
                      RemoteToolArguments
                    )(args).pipe(
                      Effect.mapError(
                        () =>
                          new ConnectionError({
                            message:
                              "Use a JSON object for the connected tool's arguments.",
                          })
                      )
                    )
                    const result = owner
                      ? yield* connectionNative(() =>
                          connectionRpc(this.env.AGENT.getByName(owner)).call(
                            tool.name,
                            JSON.stringify(input)
                          )
                        )
                      : yield* this.connections.call(tool.name, input)
                    return piRemoteResult(result)
                  }).pipe(Effect.provide(WorkerTelemetry)),
                  { signal: context.abortSignal }
                )
              ),
          })
        )
      ),
    })
  }
  async connectionsV1(raw: unknown): Promise<Schema.Json> {
    const work = this.actorRuntime.runPromiseExit(
      Effect.gen({ self: this }, function* () {
        yield* Effect.yieldNow
        const request = Schema.decodeUnknownSync(ConnectionRequest)(raw)
        yield* connectionNative(() => this.lifecycle.start())
        switch (request._tag) {
          case "Resolve":
            return yield* this.connections.resolve(request.names)
          case "Call": {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(RemoteToolArguments)
            )(request.argumentsJson).pipe(
              Effect.mapError(
                () =>
                  new ConnectionError({
                    message:
                      "Use a JSON object for the connected tool's arguments.",
                  })
              )
            )
            return yield* this.connections.call(request.name, input)
          }
        }
      }).pipe(
        Effect.map(Schema.decodeUnknownSync(ConnectionResult)),
        Effect.provide(WorkerTelemetry)
      )
    )
    this.ctx.waitUntil(work)
    const exit = await work
    if (Exit.isFailure(exit) && ConnectionOutcome.isUnexpected(exit))
      reportHarness(exit.cause, "personal")
    return ConnectionOutcome.encode(exit)
  }
  async skillVersionsV1(raw: unknown): Promise<Schema.Json> {
    const work = this.actorRuntime.runPromiseExit(
      Effect.gen({ self: this }, function* () {
        yield* Effect.yieldNow
        const references = Schema.decodeUnknownSync(SkillReferences)(raw)
        yield* skillNative(() => this.lifecycle.start())
        return yield* this.skillService.resolve(references)
      }).pipe(
        Effect.map(Schema.decodeUnknownSync(ResolvedSkills)),
        Effect.provide(WorkerTelemetry)
      )
    )
    this.ctx.waitUntil(work)
    const exit = await work
    if (Exit.isFailure(exit) && SkillOutcome.isUnexpected(exit))
      reportHarness(exit.cause, "personal")
    return SkillOutcome.encode(exit)
  }
  current(id: string) {
    return this.conversations.get(id)
  }

  async acceptMessage(input: Submission) {
    return this.run(admissionResponse(this.messageAdmission(input)))
  }

  resolveModelCredential(provider: string) {
    const refreshed = modelCallback(
      this.actorRuntime.runPromiseExit(
        this.accountCredentialProgram(provider).pipe(
          Effect.map((value) => (value ? nativeAccountToken(value) : undefined))
        )
      )
    )
    this.ctx.waitUntil(
      refreshed.then(
        () => undefined,
        () => undefined
      )
    )
    return refreshed
  }
  readonly activity: typeof Activity.Service =
    this.actorRuntime.runSync(Activity)
  async activityV1(raw: unknown): Promise<Schema.Json> {
    const work = this.actorRuntime.runPromiseExit(
      Effect.gen({ self: this }, function* () {
        yield* Effect.yieldNow
        const request = Schema.decodeUnknownSync(ActivityRequest)(raw)
        return request._tag === "Snapshot"
          ? yield* this.activity.snapshot(request.agent, request.query)
          : yield* this.activity.conversation(request.id, request.cursor)
      }).pipe(
        Effect.map(Schema.decodeUnknownSync(ActivityResult)),
        Effect.provide(WorkerTelemetry)
      )
    )
    this.ctx.waitUntil(work)
    const exit = await work
    if (Exit.isFailure(exit) && ActivityOutcome.isUnexpected(exit))
      reportHarness(exit.cause, "personal")
    return ActivityOutcome.encode(exit)
  }
  async activityConversation(
    id: string,
    cursor: RunCursor | null = null
  ): Promise<ActivityConversation | null> {
    return this.run(this.activity.conversation(id, cursor))
  }
  async activityAgents(): Promise<ActivityAgent[]> {
    return this.run(this.activity.agents())
  }
  agentProfiles(): Promise<readonly AgentProfile[]> {
    return this.actorRuntime.runPromise(
      Effect.flatMap(AgentCatalog, (catalog) => catalog.list())
    )
  }
  async readActivity(
    agent: ActivityAgent,
    query: ActivityQuery
  ): Promise<ActivitySnapshot> {
    return this.run(this.activity.snapshot(agent, query))
  }
  async agentProfile(id: string): Promise<AgentProfile | null> {
    const agentId = Schema.decodeUnknownSync(AgentId)(id)
    return this.actorRuntime.runPromise(
      Effect.flatMap(AgentCatalog, (c) => c.requireActive(agentId)).pipe(
        preserveFatal,
        Effect.catchTag("AgentNotFound", () => Effect.succeed(null))
      )
    )
  }
  protected accountConnectedProgram() {
    return this.credentialService
      .list()
      .pipe(
        Effect.map((items) =>
          items.some(
            (item) => item.providerId === "openai" && item.type === "oauth"
          )
        )
      )
  }
  protected modelConnectedProgram() {
    return Effect.gen({ self: this }, function* () {
      const owner = (yield* this.configurationService.read())?.owner
      return owner
        ? yield* accountNative(() =>
            accountConnectionRpc(this.env.AGENT.getByName(owner)).connected()
          )
        : yield* this.accountConnectedProgram()
    })
  }
  private conversationConnected() {
    return this.modelConnectedProgram().pipe(
      Effect.catchCause((cause) =>
        Effect.failCause(
          Cause.map(
            cause,
            (error) =>
              new ConversationExecutionError({
                operation: "read model connection",
                cause: error,
              })
          )
        )
      )
    )
  }
  async modelConnectionV1(): Promise<Schema.Json> {
    const work = this.actorRuntime.runPromiseExit(
      Effect.yieldNow.pipe(
        Effect.andThen(this.accountConnectedProgram()),
        Effect.provide(WorkerTelemetry)
      )
    )
    this.ctx.waitUntil(work)
    const exit = await work
    if (Exit.isFailure(exit) && AccountConnectionOutcome.isUnexpected(exit))
      reportHarness(exit.cause, "personal")
    return AccountConnectionOutcome.encode(exit)
  }
  async modelConnected(): Promise<boolean> {
    return modelCallback(
      this.actorRuntime.runPromiseExit(this.modelConnectedProgram())
    )
  }
  private communicationIdentity(
    owner: string,
    id: AgentId
  ): Effect.Effect<void, AgentConflict | AgentSynchronizationError> {
    return Effect.gen({ self: this }, function* () {
      if (
        !this.ctx.id.equals(
          this.env.AGENT.idFromName(agentObjectName(owner, id))
        )
      )
        return yield* new AgentConflict({ message: "Incorrect bot identity." })
      yield* this.communication.repository
        .bindIdentity({ owner, bot: id })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.failCause(
              Cause.map(cause, (error) =>
                error.code === "forbidden" || error.code === "invalid"
                  ? new AgentConflict({
                      message: "Bot identity could not be confirmed.",
                    })
                  : new AgentSynchronizationError({
                      operation: "bind mailbox identity",
                    })
              )
            )
          )
        )
    })
  }
  private configureProgram(
    owner: string,
    profile: AgentProfile,
    communicationOwner?: string
  ): Effect.Effect<
    void,
    AgentConflict | AgentStorageError | AgentSynchronizationError
  > {
    return Effect.gen({ self: this }, function* () {
      if (communicationOwner)
        yield* this.communicationIdentity(communicationOwner, profile.id)
      yield* this.synchronizeConfiguration(owner, profile)
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.failCause(
          Cause.map(cause, (error) => {
            switch (error._tag) {
              case "AgentConflict":
              case "AgentStorageError":
              case "AgentSynchronizationError":
                return error
              default:
                return new AgentSynchronizationError({
                  operation: "apply bot profile",
                })
            }
          })
        )
      )
    )
  }
  private prepareCommunicationProgram(
    owner: string,
    id: AgentId
  ): Effect.Effect<void, typeof AgentFailure.Type> {
    return Effect.gen({ self: this }, function* () {
      if (
        !this.ctx.id.equals(
          this.env.AGENT.idFromName(agentObjectName(owner, id))
        )
      )
        return yield* new AgentConflict({ message: "Incorrect bot identity." })
      const profile = yield* agentRpcNative(() =>
        agentRpc(this.env.AGENT.getByName(owner)).profile(id)
      )
      if (!profile)
        return yield* new AgentConflict({ message: "Bot unavailable." })
      yield* this.configureProgram(id === homeAgentId ? "" : owner, profile)
      yield* this.communicationIdentity(owner, id)
    })
  }
  async prepareCommunication(owner: string, id: AgentId): Promise<void> {
    return modelCallback(
      this.actorRuntime.runPromiseExit(
        this.prepareCommunicationProgram(owner, id)
      )
    )
  }
  async configureBot(
    owner: string,
    profile: AgentProfile,
    communicationOwner?: string
  ): Promise<void> {
    const input = configurationInput(owner, profile)
    return modelCallback(
      this.actorRuntime.runPromiseExit(
        this.configureProgram(input.owner, input.profile, communicationOwner)
      )
    )
  }
  async agentV1(raw: unknown): Promise<Schema.Json> {
    const work = this.actorRuntime.runPromiseExit(
      Effect.gen({ self: this }, function* () {
        yield* Effect.yieldNow
        const request = Schema.decodeUnknownSync(AgentRequest)(raw)
        switch (request._tag) {
          case "Profiles":
            return yield* this.catalog.list()
          case "Contacts":
            return (yield* this.catalog.list())
              .filter((profile) => profile.status === "active")
              .map(({ id, name }) => ({ id, name }))
          case "Profile":
            return yield* this.catalog.requireActive(request.id).pipe(
              preserveFatal,
              Effect.catchTag("AgentNotFound", () => Effect.succeed(null))
            )
          case "Status":
            return yield* this.runtimeStatusProgram().pipe(
              Effect.catchCause((cause) =>
                Effect.failCause(
                  Cause.map(cause, () => new AgentRuntimeUnavailable())
                )
              )
            )
          case "Configure":
            yield* this.configureProgram(
              request.owner,
              request.profile,
              request.communicationOwner
            )
            return true as const
          case "PrepareCommunication":
            yield* this.prepareCommunicationProgram(request.owner, request.id)
            return true as const
        }
      }).pipe(
        Effect.map(Schema.decodeUnknownSync(AgentResult)),
        Effect.provide(WorkerTelemetry)
      )
    )
    this.ctx.waitUntil(work)
    const exit = await work
    if (Exit.isFailure(exit) && AgentOutcome.isUnexpected(exit))
      reportHarness(exit.cause, "personal")
    return AgentOutcome.encode(exit)
  }

  private httpProgram(request: Request) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.yieldNow
      const url = new URL(request.url)
      const path = url.pathname.replace("/api/agent/", "")
      const base = path.split("/")[0]
      if (
        [
          "communication",
          "connections",
          "remote-tools",
          "access",
          "skills",
          "skill-selection",
          "bots",
        ].includes(base ?? "")
      )
        return yield* this.authorityHttpProgram(request, path)
      if (
        [
          "webhooks",
          "routines",
          "background",
          "delegations",
          "plans",
          "objects",
          "apps",
          "execution",
          "terminal",
          "browser",
          "files",
        ].includes(base ?? "")
      )
        return yield* this.workbenchHttpProgram(request, path)
      return yield* this.conversationHttpProgram(request, path)
    })
  }
  private authorityHttpProgram(request: Request, path: string) {
    return Effect.gen({ self: this }, function* () {
      const base = path.split("/")[0]

      if (base === "communication") {
        const context = yield* this.communication.runtime.contextEffect
        return yield* communicationRequest(request, path).pipe(
          Effect.provideContext(context)
        )
      }
      if (base === "connections")
        return yield* connectionRequest(
          this.connections,
          request,
          path,
          request.headers.get("x-app-origin")!
        )
      if (path === "remote-tools") {
        if (request.method === "GET")
          return Response.json(yield* this.remoteSelection.selection())
        if (request.method !== "POST")
          return new Response(null, { status: 405 })
        return yield* connectionResponse(
          Effect.gen({ self: this }, function* () {
            const input = yield* connectionDecode(
              SelectRemoteTools,
              yield* connectionJson(request)
            )
            const previous = yield* this.remoteSelection.selection()
            const owner = (yield* this.configurationService.read())?.owner
            const saved = yield* selectRemoteTools(
              this.remoteSelection,
              input,
              (names) =>
                owner
                  ? remoteToolResolution(
                      connectionNative(() =>
                        connectionRpc(this.env.AGENT.getByName(owner)).resolve(
                          names
                        )
                      )
                    )
                  : remoteToolResolution(this.connections.resolve(names)),
              () =>
                this.writable(
                  () =>
                    new ConnectionError({
                      message: "Could not confirm bot authority.",
                    })
                )
            )
            for (const tool of previous.tools)
              if (!saved.tools.some((value) => value.name === tool.name))
                yield* this.access.revoke(tool.name)
            this.installRemoteTools(saved.tools)
            this.access.notify()
            return saved
          }).pipe(
            preserveFatal,
            Effect.mapError((error) => {
              switch (error._tag) {
                case "AgentConflict":
                case "AgentStorageError":
                case "AccessDenied":
                case "AccessConflict":
                case "AccessStorageError":
                  return new ConnectionError({
                    message:
                      "Could not update these tools. Reload and retry the same selection.",
                  })
                default:
                  return error
              }
            })
          )
        )
      }
      if (base === "access") {
        const response = yield* accessRequest(this.access, request, path, () =>
          this.writable(
            (cause) =>
              new AccessStorageError({
                operation: "read access authority",
                cause,
              })
          )
        )
        if (response.ok && request.method !== "GET")
          yield* agentNative("wake conversation", () => this.runner.wake())
        return response
      }
      if (path.startsWith("skills/import/"))
        return yield* importSkillsRequest(this.connections, request, path)
      if (base === "skills")
        return yield* skillsRequest(this.skillService, request, path)
      if (path === "skill-selection") {
        if (request.method === "GET")
          return Response.json(yield* this.skillService.selection())
        return yield* skillResponse(
          Effect.gen({ self: this }, function* () {
            const input = yield* Schema.decodeUnknownEffect(SelectSkills)(
              yield* readSkillJson(request)
            )
            const owner = (yield* this.configurationService.read())?.owner
            return yield* selectBotSkills(
              this.skillService,
              input,
              (references) =>
                owner
                  ? skillResolution(
                      skillNative(() =>
                        skillRpc(this.env.AGENT.getByName(owner)).resolve(
                          references
                        )
                      )
                    )
                  : skillResolution(this.skillService.resolve(references)),
              () =>
                this.writable(
                  () =>
                    new SkillConflict({
                      message: "Could not confirm bot authority.",
                    })
                )
            )
          }).pipe(
            preserveFatal,
            Effect.mapError((error) => {
              switch (error._tag) {
                case "AgentConflict":
                case "AgentStorageError":
                  return new SkillConflict({
                    message:
                      "The skill request could not be completed. Reload and try again.",
                  })
                default:
                  return error
              }
            })
          )
        )
      }
      if (path === "bots" && request.method === "GET")
        return yield* this.catalogHttp.request(request)
      if (path.startsWith("bots/") && request.method === "POST")
        return yield* agentCatalogRequest(
          this.catalog,
          this.archiveProfile,
          path,
          request.headers.get("x-owner-id")!,
          yield* agentJson(request, Schema.Unknown)
        )

      return new Response("Not found", { status: 404 })
    })
  }
  private workbenchHttpProgram(request: Request, path: string) {
    return Effect.gen({ self: this }, function* () {
      const base = path.split("/")[0]

      if (path === "webhooks/incoming" && request.method === "POST")
        return yield* webhookIncoming(this.webhooks, request, () =>
          webhookNative(() => this.routineRunner.wake())
        )
      if (base === "webhooks")
        return yield* webhookOwnerRequest(this.webhooks, request, path)
      if (base === "routines")
        return yield* routinesRequest(
          this.routines,
          request,
          path,
          () =>
            agentNative("wake routines", () => this.routineRunner.wake()).pipe(
              Effect.catchCause((cause) =>
                Effect.failCause(
                  Cause.map(
                    cause,
                    (error) =>
                      new RoutineStorageError({
                        operation: "wake routines",
                        cause: error,
                      })
                  )
                )
              )
            ),
          (id) =>
            Effect.gen({ self: this }, function* () {
              yield* agentNative("wake conversation", () => this.runner.wake())
              yield* agentNative("wake routines", () =>
                this.routineRunner.wake()
              )
              const run = yield* this.routines.cancelPendingRun(id)
              if (run?.status === "queued") {
                yield* this.conversationService.requestStop(run.turnId)
                yield* this.access.cancel(run.turnId)
              }
              this.notifyConversation()
            }).pipe(
              preserveFatal,
              Effect.mapError((cause) => {
                switch (cause._tag) {
                  case "RoutineConflict":
                  case "RoutineStorageError":
                    return cause
                  default:
                    return new RoutineStorageError({
                      operation: "stop routine",
                      cause,
                    })
                }
              })
            )
        )
      if (base === "background")
        return yield* backgroundRequest(this.background, request, path)
      if (base === "delegations")
        return yield* delegationsRequest(this.delegations, request, path)
      if (base === "plans")
        return yield* plansRequest(this.plans, request, path)
      if (base === "objects")
        return yield* objectsRequest(this.objects, request, path, (id) =>
          this.conversations.get(id).pipe(
            Effect.map((turn) =>
              turn
                ? {
                    id: turn.id,
                    text: turn.text,
                    answer: turn.answer,
                    createdAt: turn.created_at,
                  }
                : undefined
            ),
            Effect.mapError(
              () =>
                new ObjectFailure({
                  code: "unavailable",
                  message: "Could not read the origin request.",
                })
            )
          )
        )

      if (base === "apps")
        return yield* appsRequest(
          this.appService,
          request,
          path,
          () =>
            agentNative("wake app events", () => this.appEvents.wake()).pipe(
              Effect.catchCause((cause) =>
                Effect.failCause(
                  Cause.map(
                    cause,
                    (error) =>
                      new AppStorageError({
                        operation: "wake app events",
                        cause: error,
                      })
                  )
                )
              )
            ),
          this.webApps
        )
      if (base === "execution")
        return yield* executionRequest(this.executions, request, path, (task) =>
          this.ctx.waitUntil(
            modelCallback(this.actorRuntime.runPromiseExit(task))
          )
        )
      if (path === "terminal/files/import" && request.method === "POST")
        return yield* importWorkspaceFile(this.copyWorkspaceFile, request)
      if (base === "browser")
        return yield* browserRequest(this.browser, request, path)
      if (base === "files") return yield* this.filesHttpProgram(request, path)

      return new Response("Not found", { status: 404 })
    })
  }
  private filesHttpProgram(request: Request, path: string) {
    return Effect.gen({ self: this }, function* () {
      if (
        request.method !== "GET" &&
        (yield* this.configurationService.read())?.status === "archived"
      )
        return Response.json(
          { error: "Restore this agent before changing its files." },
          { status: 409 }
        )
      const operation = filesRequest(request, path, (program, options) =>
        this.actorRuntime
          .runPromiseExit(this.downloadLock.withPermits(1)(program), options)
          .then((exit) =>
            Exit.isFailure(exit)
              ? Exit.failCause(
                  Cause.map(exit.cause, (error) => {
                    switch (error._tag) {
                      case "FileRejected":
                      case "FileNotFound":
                      case "WorkspaceReadOnly":
                      case "WorkspaceUnavailable":
                        return error
                      default:
                        return new WorkspaceUnavailable()
                    }
                  })
                )
              : Exit.succeed(exit.value)
          )
      )
      const response = yield* path === "files/upload"
        ? this.uploadLock.withPermits(1)(operation)
        : operation
      if (response.ok && request.method === "POST")
        yield* agentNative("wake extraction", () => this.extraction.wake())
      return response
    })
  }
  private conversationHttpProgram(request: Request, path: string) {
    return Effect.gen({ self: this }, function* () {
      const url = new URL(request.url)
      if (`${request.method} ${path}` === "GET export")
        return yield* exportResponse(
          url.searchParams.get("format") === "html",
          {
            signal: request.signal,
            run: (program, options) =>
              this.actorRuntime.runPromiseExit(
                program.pipe(Effect.provide(WorkerTelemetry)),
                options
              ),
          }
        )
      if (isMemoryRead(request, path))
        return yield* memoryReadRequest(request, path)
      if (`${request.method} ${path}` === "GET events")
        return conversationEvents(
          {
            snapshot: () => this.snapshotProgram(),
            activeSession: () =>
              this.conversationService
                .active()
                .pipe(Effect.map((turn) => turn?.session_id ?? undefined)),
            watch: (id) => this.harness.session(id).events(),
            subscribe: (listener) => {
              this.conversationListeners.add(listener)
              return () => this.conversationListeners.delete(listener)
            },
          },
          request.signal,
          url.searchParams.get("protocol") === "tanstack",
          (program, options) =>
            this.actorRuntime.runPromiseExit(
              program.pipe(Effect.provide(WorkerTelemetry)),
              options
            ),
          {
            checkpoint: this.conversationCheckpoint,
            after: url.searchParams.get("after"),
          }
        )
      if (`${request.method} ${path}` === "GET state")
        return Response.json(yield* this.snapshotProgram())
      if (`${request.method} ${path}` === "POST memory/retry") {
        const input = yield* agentJson(
          request,
          Schema.Struct({
            ...Part.fields,
            operationId: CancelInput.fields.operationId,
          })
        )
        yield* this.retrySummary(input)
        return Response.json({ ok: true })
      }
      if (`${request.method} ${path}` === "POST import") {
        const input = yield* agentJson(request, ImportInput, 1_100_000)
        return yield* memoryImportResponse(this.importMemory(input.jsonl))
      }
      if (`${request.method} ${path}` === "GET inference")
        return Response.json({ attempts: yield* this.inferenceUsage.recent() })
      if (`${request.method} ${path}` === "GET models") {
        const catalog = yield* this.catalogProgram()
        const selection = yield* this.conversationService.selection()
        const assignments = yield* Effect.forEach(jobTypes, (job) =>
          this.conversationService
            .jobSetting(job)
            .pipe(
              Effect.map(
                (setting) => [job, resolveRoute(job, setting)] as const
              )
            )
        )
        return Response.json({
          ...catalog,
          selection,
          assignments: Object.fromEntries(assignments),
        })
      }
      if (`${request.method} ${path}` === "POST settings") {
        const { job = "conversation", ...settings } = yield* agentJson(
          request,
          Schema.Struct({
            ...ModelSettings.fields,
            job: Schema.optional(JobType),
          })
        )
        const catalog = yield* this.catalogProgram()
        yield* Effect.try({
          try: () => validateRoute(settings, catalog),
          catch: (cause) => {
            const expected = Schema.decodeUnknownOption(ModelUnavailable)(cause)
            if (expected._tag === "Some") return expected.value
            throw cause
          },
        })
        yield* this.conversationService.setJobSetting(job, settings)
        const selection = yield* this.conversationService.selection()
        this.notifyConversation()
        return Response.json(selection)
      }
      if (`${request.method} ${path}` === "POST send")
        return yield* admissionResponse(
          this.messageAdmission(yield* agentJson(request, SendInput))
        )
      if (`${request.method} ${path}` === "POST retry") {
        const input = yield* agentJson(
          request,
          Schema.Struct({
            operationId: CancelInput.fields.operationId,
            turnId: CancelInput.fields.operationId,
          })
        )
        return yield* admissionResponse(this.retryMessage(input))
      }
      if (`${request.method} ${path}` === "POST cancel") {
        const input = yield* agentJson(request, CancelInput)
        yield* this.stopConversation(input.operationId)
        return Response.json({ ok: true }, { status: 202 })
      }

      return new Response("Not found", { status: 404 })
    })
  }
  async fetch(request: Request): Promise<Response> {
    await this.lifecycle.start()
    if (isMailboxRequest(request)) return this.communication.rpc(request)
    const path = new URL(request.url).pathname.replace("/api/agent/", "")
    if (
      (path === "terminal" || path.startsWith("terminal/")) &&
      (path !== "terminal/files/import" || request.method !== "POST")
    ) {
      const response = proxyTerminalRequest(
        request,
        this.env.TERMINAL_SERVICE,
        this.ctx.id.toString()
      )
      this.ctx.waitUntil(response)
      return response
    }
    const response = modelCallback(
      this.actorRuntime.runPromiseExit(
        this.httpProgram(request).pipe(
          Effect.scoped,
          agentResponse,
          Effect.provide(WorkerTelemetry)
        ),
        { signal: request.signal }
      )
    )
    // Pin finite request work and cleanup if the caller departs. Returned
    // streaming bodies retain their separate reader/callback ownership.
    this.ctx.waitUntil(response)
    return response
  }

  async runtimeStatus(): Promise<RuntimeStatus> {
    return this.run(this.runtimeStatusProgram())
  }
  private snapshotMetadata() {
    return Effect.gen({ self: this }, function* () {
      const runtime = yield* this.runtimeStatusProgram()
      const access = yield* this.access.state()
      const connected = yield* this.conversationConnected()
      const memory = yield* memoryReport().pipe(
        Effect.provideService(MemoryRepository, this.memory),
        Effect.provideService(MemoryBackupStatus, this.backupStatus)
      )
      const usage = yield* this.inferenceUsage.accountTotals().pipe(
        preserveFatal,
        Effect.mapError(
          (cause) =>
            new ConversationStorageError({
              operation: "read snapshot reports",
              cause,
            })
        )
      )
      return {
        runtime,
        access,
        connected,
        memory: { ...memory, usage },
      }
    })
  }
  async snapshot(): Promise<ChatState> {
    return this.run(this.snapshotProgram())
  }
  async step(): Promise<LifecycleJobOutcome> {
    const next = await this.actorRuntime.runPromise(
      this.active().pipe(
        Effect.andThen(this.conversationPump.run()),
        Effect.provide(WorkerTelemetry)
      )
    )
    return next === undefined ? undefined : { rescheduleAt: next }
  }
}

export default { fetch: agentGateway }

function isMemoryRead(
  request: Request,
  path: string
): path is "tree" | "search" | "zoom" {
  return (
    request.method === "GET" &&
    (path === "tree" || path === "search" || path === "zoom")
  )
}
