import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  or,
} from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import { Effect, Schema } from "effect"

import { ResolvedRoute, type JobType } from "../../inference/policy"
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
import type { ConversationLedger } from "../ledger"
import { RecoveryView } from "../recovery"
import {
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

const activeStatuses = ["queued", "preparing", "running", "stopping"]
const RawTurn = Schema.Struct({
  ...TurnRecord.fields,
  origin: Schema.NullOr(Schema.String),
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
const attempt = <TValue>(body: () => TValue) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const failure = conversationFailure(cause)
      if (failure) return failure
      throw cause
    },
  })

export class ConversationStore implements ConversationLedger {
  readonly transactionGroup: object
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
  statusTurns(): ReturnType<ConversationLedger["statusTurns"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const active = yield* this.query((orm) =>
          orm
            .select({
              id: chatTurns.id,
              status: chatTurns.status,
              recovery: chatTurns.recovery,
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
              status: TurnRecord.fields.status,
              phase: Schema.NullOr(RecoveryView.fields.phase),
            })
          )({
            id: row.id,
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
          return {
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
    return this.query((orm) =>
      orm
        .select(includeInput ? getTableColumns(chatTurns) : visible)
        .from(chatTurns)
        .where(or(eq(chatTurns.id, rootId), eq(chatTurns.parent_id, rootId)))
        .orderBy(asc(chatTurns.sequence))
    ).pipe(Effect.map((rows) => rows.map(restore)))
  }
  admit(
    input: Submission,
    prepared?: PreparedMessage,
    skills: readonly SkillDocument[] = [],
    resolved?: ResolvedRoute
  ): ReturnType<ConversationLedger["admit"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const source = input.retryOf
          ? yield* this.get(input.retryOf)
          : undefined
        const origin = input.retryOf ? source?.origin : input.origin
        const creation = Domain.submissionIdentity(input, origin)
        const existing = yield* this.get(input.operationId)
        if (existing) {
          yield* attempt(() => Domain.requireReplay(existing, input, creation))
          return { turn: existing, accepted: false }
        }
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
        const content = Domain.admissionContent(parent, skills, prepared)
        yield* this.query((orm) =>
          orm.insert(chatTurns).values({
            id: input.operationId,
            text: input.text,
            status: "queued",
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
          })
        )
        if (parent)
          yield* this.query((orm) =>
            orm
              .update(chatTurns)
              .set({ revision: increment(chatTurns.revision) })
              .where(eq(chatTurns.id, parent.id))
          )
        const turn = yield* this.get(input.operationId)
        if (!turn)
          return yield* Effect.die(new Error("Committed turn was not readable"))
        return { turn, accepted: true }
      })
    )
  }
  saveAttachments(
    id: string,
    prepared: PreparedMessage
  ): ReturnType<ConversationLedger["saveAttachments"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const turn = yield* this.get(id)
        if (
          !turn?.files_pending ||
          !["queued", "preparing"].includes(turn.status) ||
          turn.prompt !== null
        )
          return false
        if (
          JSON.stringify(turn.attachments.map((f) => f.id)) !==
          JSON.stringify(prepared.files.map((f) => f.id))
        )
          return yield* Effect.die(
            new Error("Prepared attachments do not match the admitted request")
          )
        yield* this.query((orm) =>
          orm
            .update(chatTurns)
            .set({
              files_pending: prepared.pending ?? false,
              attachments: JSON.stringify(prepared.files),
              input: JSON.stringify(prepared.content),
            })
            .where(eq(chatTurns.id, id))
        )
        return true
      })
    )
  }
  private updateIf(
    id: string,
    eligible: (turn: Turn) => boolean,
    change: (
      orm: EffectSqliteDatabase
    ) => Effect.Effect<unknown, EffectDrizzleQueryError>
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const turn = yield* this.get(id)
        if (turn && eligible(turn)) yield* this.query(change)
      })
    ).pipe(Effect.asVoid)
  }
  prepare(id: string): ReturnType<ConversationLedger["prepare"]> {
    return this.updateIf(id, Domain.canPrepare, (orm) =>
      orm
        .update(chatTurns)
        .set({ status: "preparing" })
        .where(eq(chatTurns.id, id))
    )
  }
  savePrompt(
    id: string,
    prompt: string
  ): ReturnType<ConversationLedger["savePrompt"]> {
    return this.updateIf(id, Domain.canSavePrompt, (orm) =>
      orm
        .update(chatTurns)
        .set({ prompt, input: "[]", skill_context: "" })
        .where(eq(chatTurns.id, id))
    )
  }
  saveSession(
    id: string,
    session: string
  ): ReturnType<ConversationLedger["saveSession"]> {
    return this.updateIf(id, Domain.canSaveSession, (orm) =>
      orm
        .update(chatTurns)
        .set({ session_id: session })
        .where(eq(chatTurns.id, id))
    )
  }
  submitted(
    id: string,
    session: string
  ): ReturnType<ConversationLedger["submitted"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const turn = yield* this.get(id)
        if (!turn || !Domain.canSubmit(turn)) return
        yield* this.query((orm) =>
          orm
            .update(chatTurns)
            .set({
              session_id: session,
              status: "running",
              started_at: coalesce(
                chatTurns.started_at,
                new Date().toISOString()
              ),
              delivery: Domain.submittedDelivery(turn),
            })
            .where(eq(chatTurns.id, id))
        )
      })
    ).pipe(Effect.asVoid)
  }
  consumed(id: string): ReturnType<ConversationLedger["consumed"]> {
    return this.updateIf(id, Domain.canConsume, (orm) =>
      orm
        .update(chatTurns)
        .set({ delivery: "consumed" })
        .where(eq(chatTurns.id, id))
    )
  }
  requestStop(id: string): ReturnType<ConversationLedger["requestStop"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const turn = yield* this.get(id)
        const rootId = Domain.stopRoot(turn)
        if (!rootId) return
        const root = yield* this.get(rootId)
        const next = Domain.stopTransition(turn, root)
        if (!next) return
        if (next.change)
          yield* this.query((orm) =>
            orm
              .update(chatTurns)
              .set({
                status: "stopping",
                stopped_at: coalesce(
                  chatTurns.stopped_at,
                  new Date().toISOString()
                ),
                revision: increment(chatTurns.revision),
              })
              .where(eq(chatTurns.id, next.rootId))
          )
        return next.rootId
      })
    )
  }
  finish(
    root: Turn,
    outcomes: readonly TurnOutcome[],
    answer: string,
    error: string | null
  ): ReturnType<ConversationLedger["finish"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const current = yield* this.get(root.id)
        if (!current)
          return yield* Effect.die(new Error("Missing conversation completion"))
        const members = yield* this.members(root.id)
        const next = Domain.finishTransition(
          root,
          current,
          members,
          outcomes,
          answer,
          error
        )
        if (!next) return false
        for (const outcome of next.members)
          yield* this.query((orm) =>
            orm
              .update(chatTurns)
              .set({
                status: outcome.status,
                files_pending: false,
                finished_at: new Date().toISOString(),
                delivery: outcome.delivery,
                input: "[]",
                prompt: null,
                skill_context: "",
              })
              .where(eq(chatTurns.id, outcome.id))
          )
        yield* this.query((orm) =>
          orm
            .update(chatTurns)
            .set({ answer: next.answer, error: next.error })
            .where(eq(chatTurns.id, root.id))
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
  return { ...row, ...decoded, origin: decoded.origin }
}
