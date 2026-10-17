import { Cause, Effect, Schema } from "effect"

import { orDieAll } from "../../shared/effect"
import { workspaceRequestBytes } from "../../workspace/adapters/http"
import type { BrowserService } from "../browser"
import {
  BrowserFailure,
  BrowserPolicy,
  BrowserNavigate,
  BrowserGeneration,
  BrowserControl,
  BrowserInteraction,
} from "../contracts"

const invalidRequest = () =>
  new BrowserFailure({
    message:
      "The browser request could not be completed. Reload and try again.",
  })

export function browserRequest(
  workspace: BrowserService,
  request: Request,
  path: string
) {
  return Effect.gen(function* () {
    if (request.method === "GET" && path === "browser")
      return Response.json(yield* workspace.state())
    if (request.method === "GET" && path === "browser/screenshot") {
      const record = yield* workspace.preview()
      if (
        new URL(request.url).searchParams.get("version") !==
        String(record.version)
      )
        return new Response("The browser preview changed.", { status: 409 })
      const image = record.screenshot
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
    const bytes = yield* workspaceRequestBytes(request, 16000).pipe(
      Effect.catchCause((cause) =>
        Effect.failCause(Cause.map(cause, invalidRequest))
      )
    )
    const input = yield* Effect.try({
      try: (): unknown => JSON.parse(new TextDecoder().decode(bytes)),
      catch: invalidRequest,
    })
    if (path === "browser/policy") {
      const policy = yield* Schema.decodeUnknownEffect(BrowserPolicy)(
        input
      ).pipe(Effect.mapError(invalidRequest))
      yield* workspace.configure(policy)
    } else if (path === "browser/open") {
      const command = yield* Schema.decodeUnknownEffect(BrowserNavigate)(
        input
      ).pipe(Effect.mapError(invalidRequest))
      yield* workspace.inspect(
        command.generation,
        command.url,
        undefined,
        "owner"
      )
    } else if (path === "browser/control") {
      const command = yield* Schema.decodeUnknownEffect(BrowserControl)(
        input
      ).pipe(Effect.mapError(invalidRequest))
      yield* workspace.control(command.generation, command.controller)
    } else if (path === "browser/interact") {
      const command = yield* Schema.decodeUnknownEffect(BrowserInteraction)(
        input
      ).pipe(Effect.mapError(invalidRequest))
      yield* workspace.interact(command, "owner")
    } else if (path === "browser/refresh" || path === "browser/close") {
      const command = yield* Schema.decodeUnknownEffect(BrowserGeneration)(
        input
      ).pipe(Effect.mapError(invalidRequest))
      if (path.endsWith("/close")) yield* workspace.close(command.generation)
      else
        yield* workspace.inspect(
          command.generation,
          undefined,
          undefined,
          "owner"
        )
    } else return new Response("Not found", { status: 404 })
    return Response.json(yield* workspace.state())
  }).pipe(
    Effect.catchCause((cause) => {
      // A typed failure may accompany a cleanup defect or interruption.
      if (Cause.hasDies(cause) || Cause.hasInterrupts(cause))
        return Effect.failCause(cause).pipe(orDieAll)
      return Effect.failCause(cause).pipe(
        Effect.catchTags({
          BrowserFailure: (error) =>
            Effect.succeed(
              Response.json({ error: error.message }, { status: 409 })
            ),
          BrowserStorageError: () =>
            Effect.succeed(
              Response.json(
                { error: invalidRequest().message },
                { status: 409 }
              )
            ),
          BrowserUnavailable: () =>
            Effect.succeed(
              Response.json(
                { error: invalidRequest().message },
                { status: 409 }
              )
            ),
        })
      )
    })
  )
}
