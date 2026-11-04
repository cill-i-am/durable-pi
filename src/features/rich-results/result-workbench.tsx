import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { DataLoading } from "@workspace/ui/components/data-loading"
import { Schema } from "effect"
import {
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"

import { ActivityConversation } from "@/activity/contracts"
import type { ChatState } from "@/conversations/contracts"
import { activityJsonRequest } from "@/features/activity/query-owner"
import { useActivityQuery } from "@/features/activity/use-activity-query"
import { parseResultReference } from "@/navigation/result-reference"
import { parseAnswerResult } from "@/rich-results/catalog"
import { richResultToolNames } from "@/rich-results/contracts"

import { createResultViewStore } from "./result-view-state"
import {
  ResultWorkspaceContext,
  type ResultSource,
} from "./result-workspace-context"
const RichResult = lazy(() =>
  import("./rich-result").then((module) => ({ default: module.RichResult }))
)

export function recordedResultSources(state: ChatState | null | undefined) {
  return (
    state?.turns.flatMap((turn) =>
      (turn.activity ?? []).flatMap((item) =>
        item.type === "tool" &&
        item.status === "done" &&
        richResultToolNames.some((name) => name === item.name) &&
        parseAnswerResult(item.output)
          ? [{ turn: turn.id, tool: item.id, output: item.output }]
          : []
      )
    ) ?? []
  )
}
export function resultSourceKey(source: Pick<ResultSource, "turn" | "tool">) {
  return JSON.stringify([source.turn, source.tool])
}

export function resultTitle(
  source: ResultSource | undefined,
  reference: string
) {
  if (!source) return "Saved result"
  const identity = parseResultReference(reference)
  const props = parseAnswerResult(source.output)?.elements[identity.element]
    ?.props
  return typeof props?.title === "string" ? props.title : "Saved result"
}

export function useRecordedResults(sources: readonly ResultSource[]) {
  const cache = useRef(new Map<string, ResultSource>())
  const [, refresh] = useState(0)
  // Recorded read-model values are immutable for a completed tool identity.
  // The signed-in, keyed assistant component owns this cache's entire lifetime.
  for (const source of sources)
    cache.current.set(resultSourceKey(source), source)
  const [store] = useState(createResultViewStore)
  useEffect(
    () => () => {
      cache.current.clear()
      store.clear()
    },
    [store]
  )
  return {
    store,
    source: (reference: string) =>
      cache.current.get(resultSourceKey(parseResultReference(reference))),
    retain: (source: ResultSource) => {
      const key = resultSourceKey(source)
      if (cache.current.get(key)?.output === source.output) return
      cache.current.set(key, source)
      refresh((revision) => revision + 1)
    },
  }
}
export function openResultReferences(
  tabs: readonly string[],
  panel: string | null,
  item: string | undefined
) {
  return panel === "results" && item && !tabs.includes(item)
    ? [...tabs, item]
    : tabs
}

export type RecordedResults = ReturnType<typeof useRecordedResults>

export function ResultWorkspaceProvider({
  results,
  opened,
  onOpen,
  children,
}: {
  results: RecordedResults
  opened: readonly string[]
  onOpen: (reference: string) => void
  children: ReactNode
}) {
  return (
    <ResultWorkspaceContext.Provider
      value={{ store: results.store, opened, open: onOpen }}
    >
      {children}
    </ResultWorkspaceContext.Provider>
  )
}

export function readRecordedResult(
  record: ActivityConversation,
  reference: string
) {
  const identity = parseResultReference(reference)
  if (record.id !== identity.turn)
    throw new Error("The saved result does not match this conversation.")
  const tool = record.activity.find(
    (item) => item.id === identity.tool && item.type === "tool"
  )
  if (
    !tool ||
    tool.type !== "tool" ||
    tool.status !== "done" ||
    !richResultToolNames.some((name) => name === tool.name) ||
    !parseAnswerResult(tool.output)?.elements[identity.element]
  )
    throw new Error("This saved result is unavailable.")
  return { turn: identity.turn, tool: identity.tool, output: tool.output }
}

export function ResultWorkbench({
  agentId,
  reference,
  results,
  active,
  onPrompt,
  onBack,
}: {
  agentId: string
  reference: string
  results: RecordedResults
  active: boolean
  onPrompt?: (prompt: string) => void
  onBack: () => void
}) {
  const live = useRef({ active, onPrompt })
  live.current = { active, onPrompt }
  useEffect(
    () => () => {
      live.current = { active: false, onPrompt: undefined }
    },
    []
  )
  const append = useCallback((prompt: string) => {
    if (live.current.active) live.current.onPrompt?.(prompt)
  }, [])
  const identity = parseResultReference(reference)
  const candidate = results.source(reference)
  const cached =
    candidate && parseAnswerResult(candidate.output)?.elements[identity.element]
      ? candidate
      : undefined
  const query = useActivityQuery({
    key: JSON.stringify(["result", agentId, reference]),
    enabled: !cached && active,
    read: async (signal) =>
      readRecordedResult(
        Schema.decodeUnknownSync(ActivityConversation)(
          await activityJsonRequest(
            agentId,
            `activity/conversations/${encodeURIComponent(identity.turn)}`,
            signal
          )
        ),
        reference
      ),
    terminal: () => true,
    errorMessage:
      "This saved result is unavailable. Return to the conversation or try again.",
  })
  const source = cached ?? query.data
  useEffect(() => {
    if (query.data) results.retain(query.data)
  }, [query.data, results])
  return (
    <div className="result-workbench workbench-body">
      {!source && !query.error && (
        <DataLoading loading label="Opening saved result" />
      )}
      {query.error && !source && (
        <Alert>
          <AlertDescription>
            {query.error}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void query.refresh()}
              >
                Try again
              </Button>
              <Button variant="ghost" size="sm" onClick={onBack}>
                Back to conversation
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      {source && (
        <RichResult
          output={source.output}
          identity={identity}
          surface="workbench"
          reference={reference}
          active={active}
          onPrompt={active && onPrompt ? append : undefined}
        />
      )}
    </div>
  )
}
