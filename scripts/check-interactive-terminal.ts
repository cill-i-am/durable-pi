import assert from "node:assert/strict"
import { Buffer as NativeBuffer } from "node:buffer"
import { request as httpRequest } from "node:http"

import { Schema } from "effect"
import { WebSocket } from "ws"

import { CommandRun, TerminalState } from "../src/terminal/contracts"

// Workers declares the Node export as any; use Node's published constructor contract.
const Buffer = NativeBuffer as BufferConstructor

const origin = "http://localhost:1337"
assert.equal(process.env.OWNER_EMAIL, "workspace-test@example.com")
async function signIn() {
  const response = await fetch(origin + "/api/auth/sign-in/email", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      email: process.env.OWNER_EMAIL,
      password: "Local test password only 2026!",
    }),
  })
  assert.equal(response.status, 200)
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ")
}
let cookie = await signIn()
const bot = crypto.randomUUID(),
  sibling = crypto.randomUUID()
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function api(path: string, body?: unknown, agent = bot) {
  return fetch(`${origin}/api/agent/${path}?agent=${agent}`, {
    method: body ? "POST" : "GET",
    headers: { cookie, origin, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
}
async function state() {
  return Schema.decodeUnknownSync(TerminalState)(
    await (await api("terminal")).json()
  )
}
async function settled(id: string) {
  for (let i = 0; i < 320; i++) {
    const s = await state()
    if (!s.busy)
      return Schema.decodeUnknownSync(CommandRun)(
        await (await api(`terminal/${id}`)).json()
      )
    await pause(150)
  }
  throw new Error("Terminal and cleanup did not settle")
}
async function start() {
  const id = crypto.randomUUID()
  assert.equal((await api("terminal/session", { id })).status, 202)
  for (let i = 0; i < 120; i++) {
    const s = await state()
    if (s.session?.phase === "ready") return id
    assert.ok(s.busy, "Session failed during startup")
    await pause(150)
  }
  throw new Error("PTY did not start")
}
function socketUrl(id: string, agent = bot) {
  return `ws://localhost:1337/api/agent/terminal/session/${id}/socket?agent=${agent}`
}
async function rejectedSocket(
  id: string,
  status: number,
  headers: Record<string, string>,
  agent = bot
) {
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(
      socketUrl(id, agent).replace("ws:", "http:"),
      { headers: { ...headers, upgrade: "websocket" } },
      (response) => {
        response.resume()
        try {
          assert.equal(response.statusCode, status)
          resolve()
        } catch (cause) {
          reject(cause)
        }
      }
    )
    request.on("error", reject)
    request.setTimeout(5000, () =>
      request.destroy(new Error("Upgrade rejection timed out"))
    )
    request.end()
  })
}
async function connect(id: string) {
  const socket = new WebSocket(socketUrl(id), { headers: { cookie, origin } })
  let output = ""
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error("PTY handshake timeout"))
    }, 10000)
    socket.on("error", reject)
    socket.on("unexpected-response", (_request, response) => {
      clearTimeout(timer)
      response.resume()
      reject(new Error("Upgrade HTTP " + response.statusCode))
    })
    socket.on("message", (data, binary) => {
      if (binary) output += data.toString()
      else if (
        Schema.decodeUnknownSync(Schema.Struct({ type: Schema.String }))(
          JSON.parse(data.toString())
        ).type === "ready"
      ) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  await ready
  return {
    socket,
    command: async (command: string) => {
      const marker = crypto.randomUUID().replaceAll("-", "")
      socket.send(
        Buffer.from(
          `${command}\n printf '\\n%s%s\\n' '${marker.slice(0, 16)}' '${marker.slice(16)}'\r`
        )
      )
      for (let i = 0; i < 100; i++) {
        if (output.includes(marker)) return output
        await pause(100)
      }
      throw new Error("PTY command did not produce its completion marker")
    },
  }
}
async function execute(command: string) {
  const id = crypto.randomUUID()
  assert.equal((await api("terminal/run", { id, command })).status, 202)
  return settled(id)
}
for (const id of [bot, sibling])
  assert.equal(
    (
      await api(
        "bots/create",
        {
          id,
          name: id === bot ? "PTY verification" : "PTY isolation",
          instructions: "",
        },
        id
      )
    ).status,
    200
  )
try {
  const id = await start()
  await rejectedSocket(id, 401, { origin })
  await rejectedSocket(id, 403, { cookie, origin: "https://evil.example" })
  await rejectedSocket(id, 409, { cookie, origin }, sibling)
  const first = await connect(id)
  await rejectedSocket(id, 409, { cookie, origin })
  assert.equal(
    (await api("terminal/run", { id: crypto.randomUUID(), command: "true" }))
      .status,
    409
  )
  first.socket.send(JSON.stringify({ type: "resize", cols: 90, rows: 30 }))
  const size = await first.command("stty size")
  assert.ok(size.includes("30 90"), "PTY resize did not reach the shell")
  first.socket.send(Buffer.from("sleep 20\r"))
  await pause(250)
  first.socket.send(Buffer.from([3]))
  await first.command("printf interrupted")
  await first.command('printf "pty-proof\\n" > /workspace/pty.txt')
  const fullBuffer = await first.command(
    "node -e 'process.stdout.write(\"x\".repeat(270000))'"
  )
  assert.ok(
    fullBuffer.includes("x".repeat(270000)),
    "Native replay buffer was not filled"
  )
  const closed = new Promise<void>((resolve) =>
    first.socket.once("close", () => resolve())
  )
  first.socket.close()
  await closed
  await pause(150)
  const second = await connect(id)
  const output = await second.command("stty size; cat /workspace/pty.txt")
  assert.ok(output.includes("pty-proof"))
  assert.equal((await api(`terminal/session/${id}/renew`, {})).status, 200)
  assert.equal((await api(`terminal/session/${id}/save`, {})).status, 200)
  second.socket.close()
  assert.equal((await settled(id)).status, "succeeded")
  const restored = await execute("cat /workspace/pty.txt")
  assert.equal(restored.status, "succeeded")
  assert.equal(restored.output, "pty-proof\n")
  assert.equal((await api("terminal/session", { id })).status, 202)
  assert.equal(
    (await state()).session,
    null,
    "A completed session must not restart"
  )

  const discarded = await start(),
    third = await connect(discarded)
  await third.command(
    "printf discarded > /workspace/pty.txt; (sleep 20; touch /workspace/orphan) &"
  )
  assert.equal((await api(`terminal/${discarded}/cancel`, {})).status, 200)
  assert.equal((await settled(discarded)).status, "cancelled")
  third.socket.close()
  const rollback = await execute(
    "cat /workspace/pty.txt; test ! -e /workspace/orphan"
  )
  assert.equal(rollback.status, "succeeded")
  assert.equal(rollback.output, "pty-proof\n")

  const expired = await start(),
    fourth = await connect(expired)
  await fourth.command("printf expired > /workspace/pty.txt")
  assert.equal(
    (
      await fetch(origin + "/api/auth/sign-out", {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    200
  )
  assert.equal((await api(`terminal/session/${expired}/renew`, {})).status, 401)
  const traffic = setInterval(() => {
    if (fourth.socket.readyState === WebSocket.OPEN)
      fourth.socket.send(Buffer.from("\r"))
  }, 1000)
  try {
    await Promise.race([
      new Promise<void>((resolve) =>
        fourth.socket.once("close", () => resolve())
      ),
      pause(33000).then(() => {
        throw new Error("Logged-out terminal exceeded lease")
      }),
    ])
  } finally {
    clearInterval(traffic)
    fourth.socket.close()
  }
  cookie = await signIn()
  assert.equal((await settled(expired)).status, "failed")
  assert.equal((await execute("cat /workspace/pty.txt")).output, "pty-proof\n")
  console.log(
    "Native PTY auth/origin/isolation/one-viewer/reconnect/save/fresh-restore/Stop/logout-lease checks passed."
  )
} finally {
  for (const id of [bot, sibling])
    await api("bots/archive", { id, archived: true }, id)
}
