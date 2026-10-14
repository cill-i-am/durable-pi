import { Schema } from "effect"
import type { ExecutionEnv } from "../../alchemy.run"
import { boundedBytes } from "../workspace/http"
import { CodeInput } from "./contracts"
import { executeCode } from "./adapters/dynamic-worker"

export default {
  async fetch(request: Request, env: ExecutionEnv) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run")
      return new Response("Not found", { status: 404 })
    try {
      const input = Schema.decodeUnknownSync(CodeInput)(
        JSON.parse(
          new TextDecoder().decode(await boundedBytes(request, 256000))
        )
      )
      return Response.json(await executeCode(env.LOADER, input, request.signal))
    } catch {
      return Response.json(
        { error: "Code execution failed or exceeded its limits." },
        { status: 422 }
      )
    }
  },
}
