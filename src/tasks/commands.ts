export type TaskCommand =
  | { action: "status"; agent?: string }
  | { action: "stop"; handle: string }
  | { action: "help" }

/** Only an explicit leading command, never instructions embedded in a document
 * or quoted email. The channel must exclude attachment-bearing requests. */
export function taskCommand(body: string): TaskCommand | undefined {
  const line = body.trimStart().split(/\r?\n/, 1)[0]!.trim()
  const match = /^\/?(STATUS|STOP)(?:\s+(.*))?$/i.exec(line)
  if (!match) return
  const value = match[2]?.trim()
  if (match[1]!.toUpperCase() === "STATUS")
    return value?.includes(" ")
      ? { action: "help" }
      : { action: "status", ...(value ? { agent: value } : {}) }
  return value && !value.includes(" ")
    ? { action: "stop", handle: value }
    : { action: "help" }
}
export const taskHelp =
  "Send STATUS for this agent, STATUS all for your agents, or STATUS <agent slug>. To stop specific work, copy its handle from STATUS and send STOP <handle>."
