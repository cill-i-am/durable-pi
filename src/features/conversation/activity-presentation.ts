import { Option, Schema } from "effect"
import { BrowserPage, Hostname } from "@/browser/contracts"
import { CommandRun } from "@/terminal/contracts"
import { RunSummary } from "@/execution/contracts"
import { FileInfo } from "@/workspace/files"
import { ResourceId, type WorkspaceSearch } from "@/navigation/workspace"
import type { ChatState, TimelineItem } from "@/conversations/contracts"

export type ToolItem = Extract<TimelineItem, { type: "tool" }>
export type WorkItem = Extract<TimelineItem, { type: "tool" | "thinking" }>
type Section =
  | { id: string; type: "work"; items: WorkItem[] }
  | Extract<TimelineItem, { type: "text" | "steer" }>
  | { id: string; type: "inline"; item: ToolItem }

export function activitySections(items: readonly TimelineItem[]): Section[] {
  const sections: Section[] = []
  let work: WorkItem[] = []
  const flush = () => {
    const first = work[0]
    if (first) sections.push({ id: first.id, type: "work", items: work })
    work = []
  }
  for (const item of items) {
    if (item.type === "text" || item.type === "steer") {
      flush()
      sections.push(item)
    } else {
      work.push(item)
      if (
        item.type === "tool" &&
        item.status === "done" &&
        item.output &&
        [
          "create_checklist",
          "read_object",
          "update_checklist",
          "publish_app",
        ].includes(item.name)
      ) {
        flush()
        sections.push({ id: `inline:${item.id}`, type: "inline", item })
      }
    }
  }
  flush()
  return sections
}

const BrowserResult = Schema.Struct({
  url: BrowserPage.fields.url,
  title: BrowserPage.fields.title,
  links: BrowserPage.fields.links,
})
const CommandResult = Schema.Struct({
  id: CommandRun.fields.id,
  status: CommandRun.fields.status,
})
const CodeResult = Schema.Struct({
  id: RunSummary.fields.id,
  status: RunSummary.fields.status,
})
const FileResult = Schema.Struct({ file: FileInfo })
const SearchInput = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
})
const SearchResult = Schema.Array(
  Schema.Struct({
    id: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    kind: Schema.String,
    date: Schema.String,
    preview: Schema.String.check(Schema.isMaxLength(300)),
  })
).check(Schema.isMaxLength(30))

export function activitySource(url: string, title = "") {
  try {
    const parsed = new URL(url)
    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      return null
    return {
      href: parsed.href,
      label: title.trim() || parsed.hostname,
      host: parsed.hostname,
      favicon:
        parsed.protocol === "https:" &&
        !parsed.port &&
        Schema.is(Hostname)(parsed.hostname)
          ? new URL("/favicon.ico", parsed.origin).href
          : null,
    }
  } catch {
    return null
  }
}

export type ToolPresentation = {
  kind: "browser" | "terminal" | "code" | "search" | "file" | "tool"
  sources: NonNullable<ReturnType<typeof activitySource>>[]
  destination?: { label: string; view: WorkspaceSearch }
}

export function toolPresentation(item: ToolItem): ToolPresentation {
  const kind: ToolPresentation["kind"] = item.name.startsWith("browser_")
    ? "browser"
    : item.name === "run_command"
      ? "terminal"
      : item.name === "run_code"
        ? "code"
        : item.name === "search_memory"
          ? "search"
          : item.name === "read_file"
            ? "file"
            : "tool"
  const result: ToolPresentation = { kind, sources: [] }
  if (!["done", "error"].includes(item.status)) return result
  if (
    ["browser_open", "browser_read", "browser_interact"].includes(item.name) &&
    item.status === "done"
  ) {
    const page = Schema.decodeUnknownOption(
      Schema.fromJsonString(BrowserResult)
    )(item.output)
    if (Option.isSome(page)) {
      const source = activitySource(page.value.url, page.value.title)
      if (source) {
        result.sources = [source]
        const seen = new Set([source.href])
        for (const link of page.value.links) {
          const next = activitySource(link.url, link.text)
          if (next && !seen.has(next.href)) {
            result.sources.push(next)
            seen.add(next.href)
          }
        }
        result.destination = {
          label: "Open current browser",
          view: { panel: "browser" },
        }
      }
    }
  } else if (kind === "terminal" || kind === "code") {
    const receipt = Schema.decodeUnknownOption(
      Schema.fromJsonString(kind === "terminal" ? CommandResult : CodeResult)
    )(item.output)
    if (
      Option.isSome(receipt) &&
      receipt.value.id.startsWith(kind === "terminal" ? "command:" : "code:") &&
      Schema.is(ResourceId)(receipt.value.id)
    )
      result.destination = {
        label:
          kind === "terminal"
            ? "Terminal · saved output"
            : "Code · saved result",
        view: { panel: kind, item: receipt.value.id },
      }
  } else if (kind === "search" && item.status === "done") {
    const input = Schema.decodeUnknownOption(
      Schema.fromJsonString(SearchInput)
    )(item.input)
    const matches = Schema.decodeUnknownOption(
      Schema.fromJsonString(SearchResult)
    )(item.output)
    if (Option.isSome(input) && Option.isSome(matches))
      result.destination = {
        label: `Memory · ${matches.value.length} ${matches.value.length === 1 ? "match" : "matches"}`,
        view: { panel: "memory", tab: "history", query: input.value.query },
      }
  } else if (kind === "file" && item.status === "done") {
    const file = Schema.decodeUnknownOption(Schema.fromJsonString(FileResult))(
      item.output
    )
    if (Option.isSome(file))
      result.destination = {
        label: file.value.file.name,
        view: { panel: "files", item: file.value.file.id },
      }
  }
  return result
}

export function workPresentation(
  items: readonly WorkItem[],
  status: ChatState["turns"][number]["status"],
  current: boolean,
  waitingForApproval: boolean
) {
  const tools = items.filter((item): item is ToolItem => item.type === "tool")
  const failed = tools.filter((item) => item.status === "error").length
  const interrupted = tools.some((item) => item.status === "interrupted")
  const unsettled = tools.some((item) =>
    ["running", "pending"].includes(item.status)
  )
  const relevant = current || unsettled
  const active = relevant && ["running", "preparing"].includes(status)
  const last = items.at(-1)
  const kind =
    last?.type === "tool" && ["running", "pending"].includes(last.status)
      ? toolPresentation(last).kind
      : "tool"
  const label =
    relevant && status === "stopping"
      ? "Stopping…"
      : relevant && status === "cancelled"
        ? "Stopped"
        : active && waitingForApproval
          ? "Waiting for approval"
          : active
            ? kind === "browser"
              ? "Browsing"
              : kind === "search"
                ? "Searching memory"
                : kind === "terminal"
                  ? "Running command"
                  : kind === "code"
                    ? "Running code"
                    : last?.type === "thinking"
                      ? "Thinking"
                      : "Working"
            : failed
              ? `Activity · ${failed} failed`
              : interrupted || unsettled || (current && status === "failed")
                ? "Interrupted"
                : tools.length
                  ? "Completed tool calls"
                  : "Thinking"
  return {
    label,
    count: tools.length,
    active: active && !waitingForApproval,
    paused:
      relevant &&
      (["stopping", "cancelled"].includes(status) ||
        (active && waitingForApproval)),
    attention:
      failed > 0 ||
      interrupted ||
      (!active && unsettled) ||
      (current && status === "failed"),
    defaultOpen:
      active ||
      failed > 0 ||
      interrupted ||
      unsettled ||
      (current && status === "failed"),
  }
}
