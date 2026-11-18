import { defineTool } from "@earendil-works/pi-durable"
import * as ToolSchema from "@earendil-works/pi-schema"
import type { Effect } from "effect"

import type { MemoryRepository } from "../repository"

const text = (value: string) => ({
  output: [{ type: "text" as const, text: value }],
})
/** SDK definitions and formatting stay at the native edge. The host applies
 * its existing approval wrapper and runs each invocation with its signal. */
export function memoryTools(
  memory: MemoryRepository["Service"],
  run: <T, TError>(
    program: Effect.Effect<T, TError>,
    signal?: AbortSignal
  ) => Promise<T>
) {
  return {
    read: [
      defineTool({
        name: "zoom",
        description:
          "Open line id+n into its two child summaries; n=1 gives the original message whole.",
        parameters: ToolSchema.obj({
          id: ToolSchema.int({ minimum: 0 }),
          n: ToolSchema.int({ minimum: 1 }),
        }),
        replay: "safe",
        execute: async (args, _api, execution) =>
          text(await run(memory.zoom(args.id, args.n), execution.abortSignal)),
      }),
      defineTool({
        name: "date",
        description: "Get the original date and time of a message.",
        parameters: ToolSchema.obj({ id: ToolSchema.int({ minimum: 0 }) }),
        replay: "safe",
        execute: async (args, _api, execution) =>
          text(
            (await run(memory.entry(args.id), execution.abortSignal))?.date ??
              "Message not found"
          ),
      }),
      defineTool({
        name: "search_memory",
        description:
          "Find exact archived messages by text, then zoom to read them. Returns at most 30 results.",
        parameters: ToolSchema.obj({
          query: ToolSchema.str({ minLength: 1, maxLength: 200 }),
        }),
        replay: "safe",
        execute: async (args, _api, execution) =>
          text(
            JSON.stringify(
              (await run(memory.search(args.query), execution.abortSignal)).map(
                ({ id, kind, text: source, date }) => ({
                  id,
                  kind,
                  date,
                  preview: source.slice(0, 300),
                })
              )
            )
          ),
      }),
      defineTool({
        name: "read_note",
        description:
          "Read a private Markdown memory note. Use path MEMORY.md for the index; an empty path lists available notes.",
        parameters: ToolSchema.obj({ path: ToolSchema.str() }),
        replay: "safe",
        execute: async (args, _api, execution) => {
          const notes = await run(memory.notes(), execution.abortSignal)
          return text(
            args.path
              ? (notes.find((note) => note.path === args.path)?.body ??
                  "Note not found")
              : notes.map((note) => note.path).join("\n")
          )
        },
      }),
    ],
    write: defineTool({
      name: "write_note",
      description:
        "Save a stable fact or correction as a private Markdown note, citing the source message ID. Use [[path]] links. Never save passwords, tokens, or secrets.",
      parameters: ToolSchema.obj({
        path: ToolSchema.str(),
        body: ToolSchema.str({ maxLength: 16000 }),
        sourceId: ToolSchema.int({ minimum: 0 }),
      }),
      replay: "safe",
      execute: async (args, _api, execution) => {
        await run(
          memory.writeNote(args.path, args.body, args.sourceId),
          execution.abortSignal
        )
        return text("Saved private memory note")
      },
    }),
  }
}
