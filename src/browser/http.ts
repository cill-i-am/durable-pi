import { Effect, Schema } from "effect"
import {
  BrowserFailure,
  BrowserPolicy,
  BrowserNavigate,
  BrowserGeneration,
  BrowserControl,
  BrowserInteraction,
} from "./contracts"
import type { BrowserWorkspace } from "./browser"
import { boundedBytes } from "../workspace/http"

export function browserRequest(
  workspace: BrowserWorkspace,
  request: Request,
  path: string
) {
  return Effect.gen(function* () {
    if (request.method === "GET" && path === "browser")
      return Response.json(workspace.state())
    if (request.method === "GET" && path === "browser/screenshot") {
      const record = workspace.repository.read()
      if (
        new URL(request.url).searchParams.get("version") !==
        String(record.version)
      )
        return new Response("The browser preview changed.", { status: 409 })
      const image = record.capture?.screenshot
      return image
        ? new Response(
            Uint8Array.from(atob(image), (character) =>
              character.charCodeAt(0)
            ),
            {
              headers: {
                "content-type": "image/jpeg",
                "cache-control": "private, no-store",
              },
            }
          )
        : new Response("No screenshot", { status: 404 })
    }
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 })
    const input = yield* Effect.tryPromise(
      async () =>
        JSON.parse(
          new TextDecoder().decode(await boundedBytes(request, 16_000))
        ) as unknown
    )
    if (path === "browser/policy") {
      const policy = yield* Effect.try(() =>
        Schema.decodeUnknownSync(BrowserPolicy)(input)
      )
      yield* workspace.configure(policy)
    } else if (path === "browser/open") {
      const command = yield* Effect.try(() =>
        Schema.decodeUnknownSync(BrowserNavigate)(input)
      )
      yield* workspace.inspect(
        command.generation,
        command.url,
        undefined,
        "owner"
      )
    } else if (path === "browser/control") {
      const command = yield* Effect.try(() =>
        Schema.decodeUnknownSync(BrowserControl)(input)
      )
      yield* workspace.control(command.generation, command.controller)
    } else if (path === "browser/interact") {
      const command = yield* Effect.try(() =>
        Schema.decodeUnknownSync(BrowserInteraction)(input)
      )
      yield* workspace.interact(command, "owner")
    } else if (path === "browser/refresh" || path === "browser/close") {
      const command = yield* Effect.try(() =>
        Schema.decodeUnknownSync(BrowserGeneration)(input)
      )
      if (path.endsWith("/close")) yield* workspace.close(command.generation)
      else
        yield* workspace.inspect(
          command.generation,
          undefined,
          undefined,
          "owner"
        )
    } else return new Response("Not found", { status: 404 })
    return Response.json(workspace.state())
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        Response.json(
          {
            error:
              cause instanceof BrowserFailure
                ? cause.message
                : "The browser request could not be completed. Reload and try again.",
          },
          { status: 409 }
        )
      )
    )
  )
}
