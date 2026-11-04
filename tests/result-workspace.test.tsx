import { it as effectIt } from "@effect/vitest"
import { send, waitFor } from "@xstate/effect"
import { Effect, Queue } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { ActivityConversation } from "../src/activity/contracts"
import { makeWorkbenchTabs } from "../src/app/use-workbench-tabs"
import { answerExamples } from "../src/features/rich-results/examples"
import { createResultViewStore } from "../src/features/rich-results/result-view-state"
import {
  readRecordedResult,
  ResultWorkspaceProvider,
} from "../src/features/rich-results/result-workbench"
import { RichResult } from "../src/features/rich-results/rich-result"
import {
  parseResultReference,
  resultReference,
  resultTab,
} from "../src/navigation/result-reference"
import type { WorkbenchTab } from "../src/navigation/workbench-tab"
import {
  parseAgentReference,
  parseResourceId,
  parseWorkspaceItem,
  workspaceBackdrop,
  workspaceDestination,
  workspaceReturnPath,
  workspaceView,
} from "../src/navigation/workspace"

const identity = {
  turn: "11111111-1111-4111-8111-111111111111",
  tool: "tool-result-1",
  element: "answer",
}
const reference = resultReference(identity)
const tableOutput = answerExamples.find(
  (example) => example.id === "table"
)!.output
const productOutput = answerExamples.find(
  (example) => example.id === "shopping"
)!.output
const source = { turn: identity.turn, tool: identity.tool, output: tableOutput }

function record(
  overrides: Partial<ActivityConversation> = {}
): ActivityConversation {
  return {
    source: "user",
    id: identity.turn,
    text: "A private request",
    answer: "",
    status: "done",
    error: null,
    activity: [
      {
        type: "tool",
        id: identity.tool,
        name: "show_ui",
        input: "{}",
        output: tableOutput,
        status: "done",
      },
    ],
    ...overrides,
  }
}

describe("recorded result identity and view retention", () => {
  it("round trips only bounded canonical identities and retains native resource bounds", () => {
    expect(parseResultReference(reference)).toEqual(identity)
    for (const invalid of [
      "../secret",
      reference + "=",
      "r_" + "x".repeat(801),
      "r_e30",
      "r_!!!!",
    ])
      expect(() => parseResultReference(invalid)).toThrow()
    expect(() =>
      resultReference({ ...identity, turn: "not-a-record" })
    ).toThrow()
    expect(() =>
      resultReference({ ...identity, element: "x".repeat(81) })
    ).toThrow()
    expect(() => parseResourceId("x".repeat(201))).toThrow()
    expect(parseWorkspaceItem("results", reference)).toBe(reference)
    const long = resultReference({
      ...identity,
      tool: "t".repeat(160),
      element: "e".repeat(80),
    })
    expect(parseWorkspaceItem("results", long)).toBe(long)
    expect(() => parseWorkspaceItem("files", long)).toThrow()
  })

  it("uses the existing result path and safe return navigation without private bodies", () => {
    const params = {
      agentId: parseAgentReference("home"),
      panel: "results" as const,
      itemId: reference,
    }
    expect(workspaceView(params, {})).toMatchObject({
      panel: "results",
      item: reference,
    })
    const path = `/agents/home/results/${reference}`
    expect(
      workspaceDestination(params.agentId, {
        panel: "results",
        item: reference,
      }).params
    ).toEqual(params)
    expect(workspaceReturnPath(path)).toBe(path)
    expect(workspaceBackdrop(path)?.view).toMatchObject({
      panel: "results",
      item: reference,
    })
    expect(workspaceReturnPath(`https://outside.invalid${path}`)).toBe("/")
    expect(() => workspaceView({ ...params, itemId: "bad" }, {})).toThrow()
    expect(() =>
      workspaceView({ agentId: params.agentId, panel: "results" }, {})
    ).toThrow()
    expect(path).not.toContain("A private request")
  })

  it("reopens only an authorized recorded rich-result tool at its exact identity", () => {
    expect(readRecordedResult(record(), reference)).toEqual(source)
    expect(() =>
      readRecordedResult(
        record({ id: "22222222-2222-4222-8222-222222222222" }),
        reference
      )
    ).toThrow()
    const tool = record().activity[0]!
    if (tool.type !== "tool") throw new Error("fixture")
    for (const invalid of [
      { ...tool, name: "arbitrary_tool" },
      { ...tool, status: "running" as const },
      { ...tool, output: "<script>unsafe</script>" },
      { ...tool, id: "different" },
    ])
      expect(() =>
        readRecordedResult(record({ activity: [invalid] }), reference)
      ).toThrow()
    expect(() =>
      readRecordedResult(
        record(),
        resultReference({ ...identity, element: "missing" })
      )
    ).toThrow()
  })

  it("renders one full editing surface and restores table/filter-builder state after presentation replacement", () => {
    const store = createResultViewStore()
    const scope = JSON.stringify(identity)
    store.write(`${scope}:table-search`, "Food", () => "")
    store.write(`${scope}:table-sort`, [{ id: "amount", desc: true }], () => [])
    store.write(`${scope}:filter-column`, "amount", () => "item")
    store.write(`${scope}:filter-operator`, "gte", () => "contains")
    store.write(`${scope}:filter-value`, "40", () => "")
    const results = { store, source: () => source, retain: () => undefined }
    const render = (surface: "inline" | "workbench", opened: string[]) =>
      renderToStaticMarkup(
        <ResultWorkspaceProvider
          results={results}
          opened={opened}
          onOpen={() => {}}
        >
          <RichResult
            output={tableOutput}
            identity={identity}
            surface={surface}
            reference={surface === "workbench" ? reference : undefined}
          />
        </ResultWorkspaceProvider>
      )
    const inline = render("inline", [])
    expect(inline).toContain('value="Food"')
    expect(inline).toContain('aria-sort="descending"')
    expect(render("inline", [reference])).not.toContain("<table")
    expect(render("inline", [reference])).toContain("View in workbench")
    const workspace = render("workbench", [reference])
    expect(workspace).toContain('value="Food"')
    expect(workspace).toContain('aria-sort="descending"')
    expect(workspace).not.toContain("Open in workbench")
    expect(render("inline", [])).toContain('value="Food"')
    expect(store.read(`${scope}:filter-value`, () => "")).toBe("40")
    expect(store.read(`${scope}:filter-column`, () => "")).toBe("amount")
    expect(store.read(`${scope}:filter-operator`, () => "")).toBe("gte")
  })

  it("retains shortlist values per element while isolating another tool and owner", () => {
    const store = createResultViewStore()
    const scope = JSON.stringify(identity)
    store.write(`${scope}:products-selected`, ["everyday", "studio"], () => [])
    store.write(`${scope}:products-view`, ["compare"], () => ["browse"])
    const results = { store, source: () => source, retain: () => undefined }
    const html = renderToStaticMarkup(
      <ResultWorkspaceProvider
        results={results}
        opened={[reference]}
        onOpen={() => {}}
      >
        <RichResult
          output={productOutput}
          identity={identity}
          surface="workbench"
          reference={reference}
        />
      </ResultWorkspaceProvider>
    )
    expect(html).toContain("Compare (2)")
    const other = JSON.stringify({ ...identity, tool: "tool-result-2" })
    expect(store.read(`${other}:products-selected`, () => [])).toEqual([])
    expect(
      createResultViewStore().read(`${scope}:products-selected`, () => [])
    ).toEqual([])
    store.clear()
    expect(store.read(`${scope}:products-selected`, () => [])).toEqual([])
  })
})

effectIt.effect(
  "result tabs keep distinct identity, hide without close, and fence late navigation",
  () =>
    Effect.gen(function* () {
      const accepted = yield* Queue.unbounded<WorkbenchTab | null>()
      let available = true
      const a = resultTab(reference)
      const b = resultTab(
        resultReference({ ...identity, tool: "tool-result-2" })
      )
      const facts = { panel: a, open: true, locked: false, overlayOpen: false }
      const { actor } = yield* makeWorkbenchTabs(facts, {
        available: () => available,
        navigate: (tab) => {
          Queue.offerUnsafe(accepted, tab)
        },
      })
      yield* send(actor, { type: "SELECT", panel: b })
      expect(yield* Queue.take(accepted)).toBe(b)
      yield* send(actor, { type: "OBSERVE", ...facts, panel: b })
      yield* send(actor, { type: "HIDE" })
      expect(yield* Queue.take(accepted)).toBeNull()
      yield* send(actor, { type: "OBSERVE", ...facts, panel: b, open: false })
      yield* waitFor(actor, (state) => state.matches("closed"))
      expect(actor.getSnapshot().context.tabs).toEqual([a, b])
      yield* send(actor, { type: "OBSERVE", ...facts, panel: b })
      yield* send(actor, { type: "CLOSE_TAB", panel: a })
      yield* waitFor(actor, (state) => state.context.tabs.length === 1)
      expect(actor.getSnapshot().context.tabs).toEqual([b])
      available = false
      yield* send(actor, { type: "SELECT", panel: "files" })
      yield* Effect.yieldNow
      expect(Queue.sizeUnsafe(accepted)).toBe(0)
    }).pipe(Effect.scoped)
)
