import { Schema } from "effect"
import { expect, it, vi } from "vitest"

import { clientErrorRequest } from "../src/observability/client-error-http"
import {
  ClientErrorReport,
  clientFailure,
  errorPage,
} from "../src/observability/client-errors"

const origin = "https://pi.example.invalid"
const file = "/assets/workspace-AbCd1234.js"
const sentinel = "PRIVATE_prompt_email@example.invalid_token"
const report: ClientErrorReport = {
  id: "12345678-1234-1234-1234-123456789abc",
  build: "a".repeat(40),
  surface: "workspace",
  page: "chat",
  online: true,
  ...clientFailure(
    {
      name: "TypeError",
      message: `Cannot read properties of undefined (reading '${sentinel}')`,
      stack: `TypeError: ${sentinel}\n at render (${origin}${file}:10:42)`,
    },
    origin
  ),
}
const request = (body: unknown = report, headers: HeadersInit = {}) =>
  new Request(origin + "/api/diagnostics/client-error", {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })

it("retains code locations and cause chains without private exception text, component names or URL capabilities", () => {
  const result = clientFailure(
    {
      name: "TypeError",
      message: `Cannot read properties of null (reading '${sentinel}')`,
      stack: `TypeError: ${sentinel}\n at ${sentinel} (${origin}${file}?token=${sentinel}#${sentinel}:12:34)\n at https://external.invalid/assets/external-AbCd1234.js:4:5\n at ${origin}/agents/${sentinel}:2:3`,
      cause: {
        name: "Error",
        message: sentinel,
        stack: `at ${origin}${file}:56:78`,
      },
    },
    origin,
    `\n at ${sentinel} (${origin}${file}:9:8)`
  )
  expect(result).toEqual({
    failure: {
      name: "TypeError",
      message: "Cannot read properties of null",
      frames: [{ file, line: 12, column: 34 }],
    },
    causes: [
      {
        name: "Error",
        message: "Unclassified browser exception",
        frames: [{ file, line: 56, column: 78 }],
      },
    ],
    components: [{ file, line: 9, column: 8 }],
  })
  expect(JSON.stringify(result)).not.toContain(sentinel)
})
it("retains a failed module and React error code without URL arguments", () => {
  expect(
    clientFailure(
      new TypeError(
        `Failed to fetch dynamically imported module: ${origin}${file}?token=${sentinel}`
      ),
      origin
    ).failure
  ).toMatchObject({
    message: "Failed to load a JavaScript module",
    module: file,
  })
  const react = clientFailure(
    new Error(
      `Minified React error #418; visit https://react.dev/errors/418?args[]=${sentinel}`
    ),
    origin
  )
  expect(react.failure).toMatchObject({
    message: "React error",
    reactCode: 418,
  })
  expect(JSON.stringify(react)).not.toContain(sentinel)
})
it("bounds frame and cause counts and handles circular causes", () => {
  const error = new Error("synthetic", { cause: new Error("cause") })
  error.stack = Array.from(
    { length: 100 },
    () => `at ${origin}${file}:1:2`
  ).join("\n")
  error.cause = error
  expect(clientFailure(error, origin).causes).toEqual([])
  expect(clientFailure(error, origin).failure.frames).toHaveLength(12)
  const chain = new Error("1", {
    cause: new Error("2", {
      cause: new Error("3", {
        cause: new Error("4", { cause: new Error("5") }),
      }),
    }),
  })
  expect(clientFailure(chain, origin).causes).toHaveLength(3)
})
it("classifies pages without retaining resource identifiers", () => {
  expect(errorPage(`/agents/${sentinel}`)).toBe("chat")
  expect(errorPage(`/agents/${sentinel}/files/${sentinel}`)).toBe("workbench")
  expect(errorPage(`/agents/${sentinel}/settings/family`)).toBe("settings")
  expect(errorPage(`/agents/${sentinel}/edit`)).toBe("editor")
  expect(errorPage("/agents")).toBe("agents")
  expect(errorPage("/family")).toBe("settings")
  expect(errorPage("/family/model-access")).toBe("settings")
  expect(errorPage("/settings/security")).toBe("settings")
})
it("logs one validated report with native error severity and no private input", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  try {
    const response = await clientErrorRequest(
      request({ ...report, prompt: sentinel, cookie: sentinel }),
      { appUrl: origin, authorize: async () => true }
    )
    expect(response.status).toBe(204)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      annotations: { event: "browser.error", ...report },
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel)
  } finally {
    log.mockRestore()
  }
})
it.each([
  { ...report, failure: { ...report.failure, message: sentinel } },
  {
    ...report,
    failure: {
      ...report.failure,
      frames: [{ file: `/agents/${sentinel}`, line: 1, column: 1 }],
    },
  },
  {
    ...report,
    failure: {
      ...report.failure,
      frames: [{ file: `${file}?token=${sentinel}`, line: 1, column: 1 }],
    },
  },
  { ...report, build: sentinel },
  { ...report, page: sentinel },
  { ...report, id: sentinel },
  { ...report, failure: { ...report.failure, name: sentinel } },
  {
    ...report,
    components: Array.from({ length: 21 }, () => ({
      file,
      line: 1,
      column: 1,
    })),
  },
])(
  "rejects unsafe or unbounded diagnostic fields without logging them %#",
  async (value) => {
    const record = vi.fn()
    const response = await clientErrorRequest(request(value), {
      appUrl: origin,
      authorize: async () => true,
      record,
    })
    expect(response.status).toBe(400)
    expect(record).not.toHaveBeenCalled()
  }
)
it("rejects oversized bodies and never forwards raw data", async () => {
  const record = vi.fn()
  expect(
    (
      await clientErrorRequest(
        request({ ...report, extra: sentinel.repeat(2000) }),
        { appUrl: origin, authorize: async () => true, record }
      )
    ).status
  ).toBe(400)
  expect(record).not.toHaveBeenCalled()
})
it.each<{ headers: Record<string, string>; status: number }>([
  { headers: { origin: "https://external.invalid" }, status: 403 },
  { headers: { origin: "" }, status: 403 },
  { headers: { "content-type": "text/plain" }, status: 415 },
  { headers: { "content-type": "application/jsonp" }, status: 415 },
])(
  "rejects cross-origin or non-JSON reports before authentication %#",
  async ({ headers, status }) => {
    const authorize = vi.fn(async () => true)
    const record = vi.fn()
    expect(
      (
        await clientErrorRequest(request(report, headers), {
          appUrl: origin,
          authorize,
          record,
        })
      ).status
    ).toBe(status)
    expect(authorize).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  }
)
it("requires active family access and fails closed if authentication is unavailable", async () => {
  const record = vi.fn()
  expect(
    (
      await clientErrorRequest(request(), {
        appUrl: origin,
        authorize: async () => false,
        record,
      })
    ).status
  ).toBe(401)
  expect(
    (
      await clientErrorRequest(request(), {
        appUrl: origin,
        authorize: async () => {
          throw new Error(sentinel)
        },
        record,
      })
    ).status
  ).toBe(503)
  expect(record).not.toHaveBeenCalled()
})
it("accepts only the bounded report contract", () => {
  expect(Schema.is(ClientErrorReport)(report)).toBe(true)
})
