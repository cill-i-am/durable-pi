import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai"
import { Harness, createRegistry, type Tx } from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { Cause, Effect, Exit } from "effect"
import { expect, it } from "vitest"

import { AccessStore } from "../src/access/adapters/sqlite"
import { scopedReceiptFact } from "../src/access/receipt"
import { AppStore } from "../src/apps/adapters/sqlite"
import { ExecutionStore } from "../src/execution/adapters/sqlite"
import {
  piWorkingObjects,
  checklistInTransaction,
} from "../src/objects/adapters/pi"
import { ObjectFailure } from "../src/objects/contracts"
import { piPlans } from "../src/planning/adapters/pi"
import {
  PlanFailure,
  type PlanDraft,
  type EvidenceRef,
} from "../src/planning/contracts"
import { planEvidence } from "../src/planning/evidence"
import { database } from "./database"

it("checks real bot/task-owned receipts, legacy execution failures, stale evidence and cold checklist reads inside native commits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plan-evidence-")),
    path = join(directory, "pi.sqlite")
  const options = { models: createModels(), registry: createRegistry() }
  let harness = await Harness.open(
    await openNodeSqliteStorage(path),
    options,
    ctx
  )
  const db = database(),
    access = new AccessStore(db, () =>
      Effect.sync(() =>
        ["run_code", "run_command", "read_note"].map((name) => ({
          name,
          mode: "allow",
          description: name,
        }))
      )
    )
  const executions = new ExecutionStore(db),
    apps = new AppStore(db, () => Effect.sync(() => true))
  const objects = piWorkingObjects(
    async () => harness,
    () => true
  )
  const root = crypto.randomUUID(),
    objectId = crypto.randomUUID(),
    id = crypto.randomUUID()
  const origin = { turnId: root, inputIds: [root], inputRevision: 0 }
  const evidence = (tx?: Tx) =>
    planEvidence({
      receipt: (query) =>
        access
          .get(query.id)
          .pipe(Effect.map((operation) => scopedReceiptFact(operation, query))),
      execution: (key) => executions.get(key),
      app: (key) => apps.get(key),
      files: () => Effect.succeed([]),
      object: (key) =>
        tx
          ? checklistInTransaction(tx, key)
          : objects.read(key).pipe(Effect.map((detail) => detail.object)),
    })
  const receipt = (
    key: string,
    tool: string,
    value: unknown,
    turnId = root
  ): EvidenceRef => {
    Effect.runSync(access.begin({ id: key, turnId, tool, input: "{}" }))
    Effect.runSync(access.claim(key))
    Effect.runSync(access.finish(key, JSON.stringify(value)))
    return {
      kind: "receipt",
      id: key,
      revision: Effect.runSync(access.get(key))!.revision,
    }
  }
  try {
    const failed = receipt("1", "run_code", {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "failed",
            output: { error: "Timed out" },
          }),
        },
      ],
    })
    expect((await Effect.runPromise(evidence()(failed, [root]))).state).toBe(
      "invalid"
    )
    const failedCommand = receipt("2", "run_command", {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "succeeded",
            exitCode: 2,
            error: null,
          }),
        },
      ],
    })
    expect(
      (await Effect.runPromise(evidence()(failedCommand, [root]))).state
    ).toBe("invalid")
    const foreign = receipt(
      "3",
      "read_note",
      { content: [] },
      crypto.randomUUID()
    )
    expect((await Effect.runPromise(evidence()(foreign, [root]))).state).toBe(
      "invalid"
    )
    const valid = receipt("4", "read_note", {
      content: [{ type: "text", text: "Saved observation" }],
    })
    expect((await Effect.runPromise(evidence()(valid, [root]))).state).toBe(
      "valid"
    )
    expect(
      (
        await Effect.runPromise(
          evidence()({ ...valid, revision: valid.revision + 1 }, [root])
        )
      ).state
    ).toBe("invalid")
    expect(
      (
        await Effect.runPromise(
          evidence()({ kind: "file", id: crypto.randomUUID(), revision: 0 }, [
            root,
          ])
        )
      ).state
    ).toBe("invalid")
    await Effect.runPromise(
      objects.mutate(
        {
          id: objectId,
          operationId: crypto.randomUUID(),
          expectedRevision: 0,
          action: {
            type: "create",
            title: "Launch checklist",
            notes: "Do not publish",
            tasks: [],
          },
        },
        { actor: "user", surface: "workbench", turnId: null, toolCallId: null }
      )
    )
    await harness.close(ctx)
    harness = await Harness.open(
      await openNodeSqliteStorage(path),
      options,
      ctx
    )
    let unavailable = false
    const checker = (tx: Tx) =>
      unavailable
        ? () =>
            Effect.fail(
              new PlanFailure({ code: "unavailable", message: "Unavailable" })
            )
        : evidence(tx)
    const plans = piPlans(
      async () => harness,
      {
        current: () => Effect.sync(() => origin),
        cancelled: () => Effect.sync(() => false),
        evidence: evidence(),
        receipts: () => Effect.sync(() => []),
      },
      checker
    )
    const draft: PlanDraft = {
      objective: "Save a launch checklist",
      constraints: ["Do not publish"],
      criteria: ["Checklist saved"],
      steps: [
        {
          id: "save",
          title: "Save checklist",
          status: "completed",
          note: "The object is the saved artifact",
          evidence: [{ kind: "object", id: objectId, revision: 1 }],
        },
      ],
      nextAction: "",
      blocker: "",
      complete: true,
    }
    await Effect.runPromise(
      plans.update(
        {
          id,
          operationId: "tool:10",
          relation: "new",
          expectedRevision: 0,
          inputRevision: 0,
          reason: "Saved checklist",
          draft,
        },
        origin
      )
    )
    expect((await Effect.runPromise(plans.read(id))).plan.state).toBe(
      "completed"
    )
    await Effect.runPromise(
      objects.mutate(
        {
          id: objectId,
          operationId: crypto.randomUUID(),
          expectedRevision: 1,
          action: {
            type: "update",
            changes: [{ type: "edit", title: "Changed checklist" }],
          },
        },
        { actor: "user", surface: "workbench", turnId: null, toolCallId: null }
      )
    )
    expect(
      (await Effect.runPromise(plans.read(id))).plan.steps[0]?.status
    ).toBe("pending")
    unavailable = true
    await Effect.runPromise(plans.cancel(root))
    expect((await Effect.runPromise(plans.read(id))).plan.state).toBe(
      "cancelled"
    )
  } finally {
    await harness.close(ctx)
    await rm(directory, { recursive: true, force: true })
  }
}, 5000)

it.each(["not_found", "unavailable"] as const)(
  "does not turn object %s plus failed evidence cleanup into unavailable/invalid evidence",
  async (code) => {
    const cleanup = new Error("Private evidence cleanup failure")
    const evidence = planEvidence({
      receipt: () => Effect.succeed(undefined),
      execution: () => Effect.succeed(undefined),
      app: () => Effect.succeed(undefined),
      files: () => Effect.succeed([]),
      object: () =>
        Effect.fail(
          new ObjectFailure({ code, message: "Object unavailable" })
        ).pipe(Effect.ensuring(Effect.die(cleanup))),
    })
    const turnId = crypto.randomUUID()
    const exit = await Effect.runPromiseExit(
      evidence({ kind: "object", id: crypto.randomUUID(), revision: 1 }, [
        turnId,
      ])
    )
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(
      Exit.isFailure(exit) &&
        exit.cause.reasons.some(
          (reason) => reason._tag === "Die" && reason.defect === cleanup
        )
    ).toBe(true)
  }
)
