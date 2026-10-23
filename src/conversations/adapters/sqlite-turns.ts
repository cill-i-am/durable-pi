import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  isNotNull,
  lt,
  or,
  sql,
} from "drizzle-orm"
import { Clock, Effect, Schema } from "effect"

import { ResolvedRoute, type JobType } from "../../inference/policy"
import { MessageProvenance } from "../../messages/identity"
import { SkillReference, type SkillDocument } from "../../skills/contracts"
import { coalesce, increment, literal } from "../../storage/expressions"
import {
  mapSqliteError,
  type Sqlite,
  type EffectSqliteDatabase,
} from "../../storage/sqlite"
import { AttachmentContent, FileInfo } from "../../workspace/files"
import { TurnOrigin } from "../contracts"
import * as Domain from "../domain"
import { advanceInput, type ConversationInputEvent } from "../input.machine"
import type { ConversationLedger } from "../ledger"
import { RecoveryView } from "../recovery"
import {
  advanceRootRun,
  newRootRun,
  completionDecision,
  ownsConversation,
  type RootRunEvent,
} from "../root-run.machine"
import {
  type AdmissionDiscovery,
  type StopDiscovery,
  type ControlPhase,
  type ControlRelease,
  ConversationControl,
  conversationControl,
  conversationUnconfirmed,
  isPending,
  ConversationConflict,
  ConversationStorageError,
  TurnRecord,
  conversationFailure,
  type PreparedMessage,
  type TurnOutcome,
  ModelSettings,
  type Submission,
  type Turn,
} from "../turns"
import { chatTurns, chatSettings, jobModelSettings } from "./schema"

const sessionOrigin = or(
  isNull(chatTurns.origin),
  inArray(sql<string>`json_extract(${chatTurns.origin}, '$.kind')`, [
    "email",
    "whatsapp",
  ])
)
const activeStatuses = ["queued", "preparing", "running", "stopping"]
const RawTurn = Schema.Struct({
  ...TurnRecord.fields,
  control: Schema.String,
  origin: Schema.NullOr(Schema.String),
  provenance: Schema.NullOr(Schema.String),
  routing: Schema.NullOr(Schema.String),
  skills: Schema.String,
  attachments: Schema.String,
  input: Schema.String,
})
const visible = {
  ...getTableColumns(chatTurns),
  prompt: literal(null),
  skill_context: literal(""),
  input: literal("[]"),
}
const membersQuery = (orm: EffectSqliteDatabase, includeInput: boolean) =>
  orm
    .select(includeInput ? getTableColumns(chatTurns) : visible)
    .from(chatTurns)
    .where(
      or(
        eq(chatTurns.id, sql.placeholder("rootId")),
        eq(chatTurns.parent_id, sql.placeholder("rootId"))
      )
    )
    .orderBy(asc(chatTurns.sequence))
    .prepare()
const attempt = <TValue>(body: () => TValue) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const failure = conversationFailure(cause)
      if (failure) return failure
      throw cause
    },
  })

function requireDiscovery(
  options: AdmissionDiscovery | undefined,
  now: number
) {
  if (
    !options ||
    !Number.isFinite(options.discoveryDeadline) ||
    options.discoveryDeadline <= now
  )
    throw new ConversationStorageError({
      operation: "admission discovery",
      cause: new Error("Conversation discovery lease is missing or expired"),
    })
}

export class ConversationStore implements ConversationLedger {
  readonly transactionGroup: object
  // Reuse compiled SQL and its row mapper, never rows or a transaction lease.
  private readonly memberQueries = new Map<
    boolean,
    ReturnType<typeof membersQuery>
  >()
  constructor(
    private readonly db: Sqlite,
    private readonly defaults: ModelSettings
  ) {
    this.transactionGroup = db
  }
  private query<TValue, TError, TRequirements>(
    body: (
      orm: EffectSqliteDatabase
    ) => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.use(body),
      (cause) => new ConversationStorageError({ operation: "query", cause })
    )
  }
  private atomic<TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.transaction(body),
      (cause) =>
        new ConversationStorageError({ operation: "transaction", cause })
    )
  }
  jobSetting(job: JobType): ReturnType<ConversationLedger["jobSetting"]> {
    if (job === "conversation")
      return this.query((orm) =>
        orm
          .select({
            model: chatSettings.model,
            thinking: chatSettings.thinking,
          })
          .from(chatSettings)
          .where(eq(chatSettings.id, 1))
          .limit(1)
      ).pipe(
        Effect.map((rows) =>
          rows[0] ? Schema.decodeUnknownSync(ModelSettings)(rows[0]) : undefined
        )
      )
    return this.query((orm) =>
      orm
        .select({
          model: jobModelSettings.model,
          thinking: jobModelSettings.thinking,
        })
        .from(jobModelSettings)
        .where(eq(jobModelSettings.job, job))
        .limit(1)
    ).pipe(
      Effect.map((rows) =>
        rows[0] ? Schema.decodeUnknownSync(ModelSettings)(rows[0]) : undefined
      )
    )
  }
  setJobSetting(
    job: JobType,
    settings: ModelSettings
  ): ReturnType<ConversationLedger["setJobSetting"]> {
    if (job === "conversation") return this.setSettings(settings)
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* this.setSettings(yield* this.settings())
        yield* this.query((orm) =>
          orm
            .insert(jobModelSettings)
            .values({ job, ...settings })
            .onConflictDoUpdate({ target: jobModelSettings.job, set: settings })
        )
        return undefined
      })
    )
  }
  settings(): ReturnType<ConversationLedger["settings"]> {
    return this.jobSetting("conversation").pipe(
      Effect.map((value) => value ?? this.defaults)
    )
  }
  setSettings(
    settings: ModelSettings
  ): ReturnType<ConversationLedger["setSettings"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* this.query((orm) =>
          orm
            .insert(chatSettings)
            .values({ id: 1, ...settings, revision: 1 })
            .onConflictDoUpdate({
              target: chatSettings.id,
              set: { ...settings, revision: increment(chatSettings.revision) },
            })
        )
        return yield* this.selection()
      })
    )
  }
  selection(): ReturnType<ConversationLedger["selection"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const settings = yield* this.settings()
        const rows = yield* this.query((orm) =>
          orm
            .select({ revision: chatSettings.revision })
            .from(chatSettings)
            .where(eq(chatSettings.id, 1))
            .limit(1)
        )
        return { ...settings, settingsRevision: rows[0]?.revision ?? 0 }
      })
    )
  }
  get(id: string): ReturnType<ConversationLedger["get"]> {
    return this.query((orm) =>
      orm.select().from(chatTurns).where(eq(chatTurns.id, id)).limit(1)
    ).pipe(Effect.map((rows) => (rows[0] ? restore(rows[0]) : undefined)))
  }
  active(): ReturnType<ConversationLedger["active"]> {
    return this.query((orm) =>
      orm
        .select()
        .from(chatTurns)
        .where(
          and(
            isNull(chatTurns.parent_id),
            inArray(chatTurns.status, activeStatuses)
          )
        )
        .orderBy(asc(chatTurns.sequence))
        .limit(1)
    ).pipe(Effect.map((rows) => (rows[0] ? restore(rows[0]) : undefined)))
  }
  unfinished() {
    return this.query((orm) =>
      orm
        .select()
        .from(chatTurns)
        .where(
          and(
            isNull(chatTurns.parent_id),
            inArray(chatTurns.status, activeStatuses)
          )
        )
        .orderBy(asc(chatTurns.sequence))
    ).pipe(Effect.map((rows) => rows.map(restore)))
  }
  recent(): ReturnType<ConversationLedger["recent"]> {
    return this.query((orm) =>
      orm
        .select(visible)
        .from(chatTurns)
        .where(isNull(chatTurns.parent_id))
        .orderBy(desc(chatTurns.sequence))
        .limit(100)
    ).pipe(Effect.map((rows) => rows.reverse().map(restore)))
  }
  sessions(before?: string) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const cursor = before
          ? yield* this.query((orm) =>
              orm
                .select({ sequence: chatTurns.sequence })
                .from(chatTurns)
                .where(eq(chatTurns.id, before))
                .limit(1)
            )
          : []
        return yield* this.query((orm) =>
          orm
            .select()
            .from(chatTurns)
            .where(
              and(
                isNull(chatTurns.parent_id),
                sessionOrigin,
                isNotNull(chatTurns.session_id),
                cursor[0]
                  ? lt(chatTurns.sequence, cursor[0].sequence)
                  : undefined
              )
            )
            .orderBy(desc(chatTurns.sequence))
            .limit(20)
        ).pipe(Effect.map((rows) => rows.map(restore)))
      })
    )
  }
  sessionForNative(id: number) {
    return this.query((orm) =>
      orm
        .select()
        .from(chatTurns)
        .where(
          and(
            eq(chatTurns.session_id, String(id)),
            isNull(chatTurns.parent_id),
            sessionOrigin
          )
        )
        .orderBy(asc(chatTurns.sequence))
        .limit(1)
    ).pipe(Effect.map((rows) => (rows[0] ? restore(rows[0]) : undefined)))
  }
  private resumable(id: string) {
    return Effect.gen({ self: this }, function* () {
      const root = yield* this.get(id)
      if (
        !root?.session_id ||
        (root.origin && !["email", "whatsapp"].includes(root.origin.kind)) ||
        root.parent_id ||
        ["failed", "cancelled", "stopping"].includes(root.status)
      )
        return yield* new ConversationConflict({
          message: "The addressed session has stopped.",
        })
      return root
    })
  }
  resumeMessage(
    input: Submission & {
      origin: Extract<TurnOrigin, { kind: "coordination" }>
    },
    options?: AdmissionDiscovery
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const root = yield* this.resumable(input.origin.turnId)
        const existing = yield* this.get(input.operationId)
        const active = yield* this.active()
        const mode =
          existing?.mode ??
          (active?.session_id === root.session_id ? "steer" : "followUp")
        return yield* this.admit(
          { ...input, mode },
          undefined,
          [],
          root.routing ?? undefined,
          options
        )
      })
    )
  }
  statusTurns(): ReturnType<ConversationLedger["statusTurns"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const active = yield* this.query((orm) =>
          orm
            .select({
              id: chatTurns.id,
              status: chatTurns.status,
              recovery: chatTurns.recovery,
              control: chatTurns.control,
              session_id: chatTurns.session_id,
              schemaVersion: chatTurns.schemaVersion,
              workflowVersion: chatTurns.workflowVersion,
            })
            .from(chatTurns)
            .where(
              and(
                isNull(chatTurns.parent_id),
                inArray(chatTurns.status, activeStatuses)
              )
            )
            .orderBy(asc(chatTurns.sequence))
            .limit(1)
        )
        const latest = yield* this.query((orm) =>
          orm
            .select({
              id: chatTurns.id,
              status: chatTurns.status,
              recovery: chatTurns.recovery,
              control: chatTurns.control,
              session_id: chatTurns.session_id,
              schemaVersion: chatTurns.schemaVersion,
              workflowVersion: chatTurns.workflowVersion,
            })
            .from(chatTurns)
            .where(isNull(chatTurns.parent_id))
            .orderBy(desc(chatTurns.sequence))
            .limit(1)
        )
        const decode = (row: (typeof active)[number] | undefined) => {
          if (!row) return undefined
          const value = Schema.decodeUnknownSync(
            Schema.Struct({
              id: Schema.String,
              schemaVersion: TurnRecord.fields.schemaVersion,
              workflowVersion: TurnRecord.fields.workflowVersion,
              status: TurnRecord.fields.status,
              phase: Schema.NullOr(RecoveryView.fields.phase),
            })
          )({
            id: row.id,
            schemaVersion: row.schemaVersion,
            workflowVersion: row.workflowVersion,
            status: row.status,
            phase: row.recovery
              ? (Schema.decodeUnknownSync(
                  Schema.fromJsonString(
                    Schema.Struct({
                      view: Schema.optional(
                        Schema.NullOr(
                          Schema.Struct({ phase: RecoveryView.fields.phase })
                        )
                      ),
                    })
                  )
                )(row.recovery).view?.phase ?? null)
              : null,
          })
          const control = Schema.decodeUnknownSync(
            Schema.fromJsonString(ConversationControl)
          )(row.control)
          const unconfirmed = conversationUnconfirmed({
            ...value,
            session_id: row.session_id,
            control,
          })
          return {
            ...(unconfirmed ? { controlUnconfirmed: unconfirmed } : {}),
            id: value.id,
            status: value.status,
            recovery: value.phase ? { phase: value.phase } : null,
          }
        }
        return { active: decode(active[0]), latest: decode(latest[0]) }
      })
    )
  }
  members(
    rootId: string,
    includeInput = true
  ): ReturnType<ConversationLedger["members"]> {
    return this.query((orm) => {
      let query = this.memberQueries.get(includeInput)
      if (!query) {
        query = membersQuery(orm, includeInput)
        this.memberQueries.set(includeInput, query)
      }
      return query.all({ rootId })
    }).pipe(Effect.map((rows) => rows.map(restore)))
  }
  visibleMembers(
    rootIds: readonly string[]
  ): ReturnType<ConversationLedger["visibleMembers"]> {
    if (!rootIds.length) return Effect.succeed([])
    return this.query((orm) => {
      // A single bound keyset keeps even 100 roots below DO SQLite's 100-variable limit.
      const roots = orm
        .$with("visible_roots")
        .as(
          orm
            .select({ id: sql<string>`value`.as("id") })
            .from(sql`json_each(${JSON.stringify(rootIds)})`)
        )
      const ids = orm.select({ id: roots.id }).from(roots)
      return orm
        .with(roots)
        .select(visible)
        .from(chatTurns)
        .where(
          or(inArray(chatTurns.id, ids), inArray(chatTurns.parent_id, ids))
        )
        .orderBy(asc(chatTurns.sequence))
    }).pipe(Effect.map((rows) => rows.map(restore)))
  }
  admit(
    input: Submission,
    prepared?: PreparedMessage,
    skills: readonly SkillDocument[] = [],
    resolved?: ResolvedRoute,
    options?: AdmissionDiscovery
  ): ReturnType<ConversationLedger["admit"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const source = input.retryOf
          ? yield* this.get(input.retryOf)
          : undefined
        const origin = input.retryOf ? source?.origin : input.origin
        const provenance = input.retryOf ? source?.provenance : input.provenance
        const creation = Domain.submissionIdentity(
          { ...input, provenance },
          origin
        )
        const existing = yield* this.get(input.operationId)
        if (existing) {
          yield* attempt(() => Domain.requireReplay(existing, input, creation))
          return { turn: existing, accepted: false }
        }
        const resumed =
          origin?.kind === "coordination"
            ? yield* this.resumable(origin.turnId)
            : undefined
        const capacity = yield* this.query((orm) =>
          orm
            .select({ n: count() })
            .from(chatTurns)
            .where(inArray(chatTurns.status, activeStatuses))
        )
        yield* attempt(() => Domain.requireCapacity(capacity[0]!.n))
        yield* attempt(() => Domain.requireRetry(input, source))
        const active = yield* this.active()
        const parent = yield* attempt(() =>
          Domain.admissionParent(input, active)
        )
        const members = parent ? yield* this.members(parent.id, false) : []
        yield* attempt(() =>
          Domain.requireSteer(
            parent,
            input,
            members.reduce((n, member) => n + member.attachments.length, 0) +
              (prepared?.files.length ?? 0)
          )
        )
        const job = input.job ?? "conversation"
        const jobSetting =
          parent || source || resolved ? undefined : yield* this.jobSetting(job)
        const settings = yield* attempt(() =>
          Domain.admissionRoute(input, {
            parent,
            source,
            resolved,
            defaults: this.defaults,
            jobSetting,
          })
        )
        const now = yield* Clock.currentTimeMillis
        yield* attempt(() => requireDiscovery(options, now))
        const content = Domain.admissionContent(parent, skills, prepared)
        const run = newRootRun(input.operationId, parent?.id ?? null)
        yield* this.query((orm) =>
          orm.insert(chatTurns).values({
            id: input.operationId,
            text: input.text,
            status: run.status,
            schemaVersion: 1,
            workflowVersion: 1,
            control: JSON.stringify(run.control),
            created_at: new Date().toISOString(),
            parent_id: parent?.id ?? null,
            mode: input.mode ?? "followUp",
            model: settings.model,
            thinking: settings.thinking,
            creation,
            files_pending: content.files_pending,
            attachments: JSON.stringify(content.attachments),
            input: JSON.stringify(content.input),
            skills: JSON.stringify(content.skills),
            skill_context: content.skill_context,
            routing: JSON.stringify(settings),
            origin: origin ? JSON.stringify(origin) : null,
            provenance: provenance
              ? Schema.encodeSync(Schema.fromJsonString(MessageProvenance))(
                  provenance
                )
              : null,
            session_id: parent ? null : (resumed?.session_id ?? null),
          })
        )
        if (parent) {
          const next = advanceRootRun(parent, { type: "STEER" })
          if (!next)
            return yield* Effect.die(new Error("Admitted steer lost its root"))
          yield* this.writeTurn(next, parent)
        }
        const turn = yield* this.get(input.operationId)
        if (!turn)
          return yield* Effect.die(new Error("Committed turn was not readable"))
        return { turn, accepted: true }
      })
    )
  }
  /** Called only inside this store's native transaction. */
  private writeTurn(next: Turn, previous: Turn) {
    return this.query((orm) =>
      orm
        .update(chatTurns)
        .set({
          schemaVersion: 1,
          workflowVersion: 1,
          status: next.status,
          revision: next.revision,
          control: JSON.stringify(conversationControl(next)),
          answer: next.answer,
          error: next.error,
          session_id: next.session_id,
          prompt: next.prompt,
          delivery: next.delivery,
          files_pending: next.files_pending ?? false,
          attachments: JSON.stringify(next.attachments),
          input: JSON.stringify(next.input),
          skill_context: next.skill_context ?? "",
          ...(next.status === "running" && previous.status !== "running"
            ? {
                started_at: coalesce(
                  chatTurns.started_at,
                  new Date().toISOString()
                ),
              }
            : {}),
          ...(next.status === "stopping" && previous.status !== "stopping"
            ? {
                stopped_at: coalesce(
                  chatTurns.stopped_at,
                  new Date().toISOString()
                ),
              }
            : {}),
          ...(!isPending(next) && isPending(previous)
            ? { finished_at: new Date().toISOString() }
            : {}),
        })
        .where(eq(chatTurns.id, next.id))
    ).pipe(Effect.asVoid)
  }
  private inputEvent(
    id: string,
    event: ConversationInputEvent,
    owner?: string
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const turn = yield* this.get(id)
        if (!turn) return false
        const root = turn.parent_id ? yield* this.get(turn.parent_id) : turn
        if (
          !root ||
          !isPending(root) ||
          !ownsConversation(root, owner) ||
          (root.status === "stopping" &&
            event.type !== "CONSUMED" &&
            event.type !== "PIN_SESSION" &&
            event.type !== "FINISH")
        )
          return false
        const next = advanceInput(turn, event)
        if (!next) return false
        const run =
          event.type === "SUBMITTED"
            ? advanceRootRun(next, { type: "SUBMITTED" })
            : undefined
        yield* this.writeTurn(run ?? next, turn)
        return true
      })
    )
  }
  private rootEvent(
    id: string,
    event: RootRunEvent | ((now: number) => RootRunEvent)
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const turn = yield* this.get(id)
        if (!turn || turn.parent_id !== null) return undefined
        const decision =
          typeof event === "function"
            ? event(yield* Clock.currentTimeMillis)
            : event
        const next = advanceRootRun(turn, decision)
        if (!next) return undefined
        yield* this.writeTurn(next, turn)
        return next
      })
    )
  }
  saveAttachments(
    id: string,
    prepared: PreparedMessage,
    owner?: string
  ): ReturnType<ConversationLedger["saveAttachments"]> {
    return this.inputEvent(id, { type: "PREPARE_ATTACHMENTS", prepared }, owner)
  }
  prepare(
    id: string,
    owner?: string
  ): ReturnType<ConversationLedger["prepare"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const turn = yield* this.get(id)
        if (!turn) return
        const root = turn.parent_id ? yield* this.get(turn.parent_id) : turn
        if (
          !root ||
          !isPending(root) ||
          root.status === "stopping" ||
          !ownsConversation(root, owner)
        )
          return
        const next = advanceRootRun(turn, { type: "PREPARE" })
        if (next) yield* this.writeTurn(next, turn)
      })
    )
  }
  savePrompt(
    id: string,
    prompt: string,
    owner?: string
  ): ReturnType<ConversationLedger["savePrompt"]> {
    return this.inputEvent(id, { type: "PIN_PROMPT", prompt }, owner).pipe(
      Effect.asVoid
    )
  }
  saveSession(
    id: string,
    session: string,
    owner?: string
  ): ReturnType<ConversationLedger["saveSession"]> {
    return this.inputEvent(id, { type: "PIN_SESSION", session }, owner).pipe(
      Effect.asVoid
    )
  }
  submitted(
    id: string,
    session: string,
    owner?: string
  ): ReturnType<ConversationLedger["submitted"]> {
    return this.inputEvent(id, { type: "SUBMITTED", session }, owner).pipe(
      Effect.asVoid
    )
  }
  consumed(
    id: string,
    owner?: string
  ): ReturnType<ConversationLedger["consumed"]> {
    return this.inputEvent(id, { type: "CONSUMED" }, owner).pipe(Effect.asVoid)
  }
  requestStop(
    id: string,
    options?: StopDiscovery
  ): ReturnType<ConversationLedger["requestStop"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const turn = yield* this.get(id)
        if (!turn || !isPending(turn)) return
        const root = turn.parent_id ? yield* this.get(turn.parent_id) : turn
        if (!root)
          return yield* Effect.die(
            new Error("A pending conversation member has no root turn")
          )
        if (
          !isPending(root) ||
          (options?.expectedRevision !== undefined &&
            root.revision !== options.expectedRevision)
        )
          return
        const next = advanceRootRun(root, {
          type: "STOP",
          now: yield* Clock.currentTimeMillis,
          discoveryDeadline: options?.discoveryDeadline ?? null,
          expectedRevision: options?.expectedRevision ?? null,
          error:
            options?.unconfirmedError ??
            "Stop is saved; native cancellation is unconfirmed.",
        })
        if (next) yield* this.writeTurn(next, root)
        return root.id
      })
    )
  }
  retryStop(
    id: string,
    expectedRevision: number,
    discoveryDeadline: number
  ): ReturnType<ConversationLedger["retryStop"]> {
    return this.rootEvent(id, (now) => ({
      type: "RETRY_STOP",
      now,
      discoveryDeadline,
      expectedRevision,
    })).pipe(Effect.map(Boolean))
  }
  claimControl(
    id: string,
    owner: string,
    deadline: number,
    mode: "automatic" | "inspect" | "stop" = "automatic",
    expectedRevision?: number
  ): ReturnType<ConversationLedger["claimControl"]> {
    return this.rootEvent(id, (now) => ({
      type: "CLAIM",
      owner,
      deadline,
      now,
      mode,
      expectedRevision: expectedRevision ?? null,
    }))
  }
  releaseControl(
    id: string,
    owner: string,
    confirmed = false,
    result?: ControlRelease
  ): ReturnType<ConversationLedger["releaseControl"]> {
    return this.rootEvent(id, {
      type: "RELEASE",
      owner,
      confirmed,
      result,
    }).pipe(Effect.map(Boolean))
  }
  exhaustControl(
    id: string,
    expectedRevision: number,
    phase: ControlPhase,
    error: string,
    eligible: () => boolean
  ): ReturnType<ConversationLedger["exhaustControl"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const turn = yield* this.get(id)
        if (
          !turn ||
          turn.parent_id !== null ||
          !isPending(turn) ||
          conversationControl(turn).owner !== null ||
          turn.revision !== expectedRevision
        )
          return false
        const next = advanceRootRun(turn, {
          type: "EXHAUST",
          expectedRevision,
          phase,
          error,
          eligible: eligible(),
        })
        if (!next) return false
        yield* this.writeTurn(next, turn)
        return true
      })
    )
  }
  restoreControl(): ReturnType<ConversationLedger["restoreControl"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        for (const root of yield* this.unfinished()) {
          const next = advanceRootRun(root, { type: "RESTORE" })
          if (next) yield* this.writeTurn(next, root)
        }
      })
    )
  }
  finish(
    root: Turn,
    outcomes: readonly TurnOutcome[],
    answer: string,
    error: string | null,
    owner?: string
  ): ReturnType<ConversationLedger["finish"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const current = yield* this.get(root.id)
        if (!current)
          return yield* Effect.die(new Error("Missing conversation completion"))
        const members = yield* this.members(root.id)
        const next = completionDecision(
          root,
          current,
          members,
          outcomes,
          answer,
          error,
          owner
        )
        if (!next) return false
        for (const member of next.members)
          yield* this.writeTurn(
            member,
            members.find((saved) => saved.id === member.id)!
          )
        return true
      })
    )
  }
}

function restore(raw: unknown): Turn {
  const row = Schema.decodeUnknownSync(RawTurn)(raw)
  const decoded = Schema.decodeUnknownSync(TurnRecord)({
    ...row,
    control: Schema.decodeUnknownSync(
      Schema.fromJsonString(ConversationControl),
      { onExcessProperty: "error" }
    )(row.control),
    provenance: row.provenance
      ? Schema.decodeUnknownSync(Schema.fromJsonString(MessageProvenance))(
          row.provenance
        )
      : undefined,
    origin: row.origin
      ? Schema.decodeUnknownSync(TurnOrigin)(JSON.parse(row.origin))
      : undefined,
    routing: row.routing
      ? Schema.decodeUnknownSync(ResolvedRoute)(JSON.parse(row.routing))
      : null,
    skills: Schema.decodeUnknownSync(Schema.Array(SkillReference))(
      JSON.parse(row.skills)
    ),
    attachments: Schema.decodeUnknownSync(Schema.Array(FileInfo))(
      JSON.parse(row.attachments)
    ),
    input: Schema.decodeUnknownSync(Schema.Array(AttachmentContent))(
      JSON.parse(row.input)
    ),
  })
  const control = decoded.control
  if (
    (control.owner === null) !== (control.deadline === null) ||
    control.owner === "" ||
    (control.deadline !== null && !Number.isFinite(control.deadline))
  )
    throw new Error("Invalid persisted conversation control")
  return {
    ...row,
    ...decoded,
    control: conversationControl(decoded),
    origin: decoded.origin,
    provenance: decoded.provenance,
  }
}
