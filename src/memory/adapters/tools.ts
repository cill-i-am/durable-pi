import { Type } from "@earendil-works/pi-ai"
import { defineTool } from "@earendil-works/pi-durable"
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
        parameters: Type.Object({
          id: Type.Integer({ minimum: 0 }),
          n: Type.Integer({ minimum: 1 }),
        }),
        replay: "safe",
        execute: async (args, _api, execution) =>
          text(await run(memory.zoom(args.id, args.n), execution.abortSignal)),
      }),
      defineTool({
        name: "date",
        description: "Get the original date and time of a message.",
        parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
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
        parameters: Type.Object({
          query: Type.String({ minLength: 1, maxLength: 200 }),
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
        parameters: Type.Object({ path: Type.String() }),
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
      parameters: Type.Object({
        path: Type.String(),
        body: Type.String({ maxLength: 16000 }),
        sourceId: Type.Integer({ minimum: 0 }),
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
