import {
  TerminalFailure,
  type CommandRun,
  type CommandInput,
  type TerminalNetworkPolicy,
} from "./contracts"
import type { TerminalAuthority } from "./repository"

export const SESSION_LEASE = 30_000
export const SESSION_LIFETIME = 10 * 60_000
export function sessionExpiry(now: number, maximumAt: number) {
  return Math.min(now + SESSION_LEASE, maximumAt)
}
export const sessionLive = (now: number, expiresAt: number, stopped: boolean) =>
  !stopped && now < expiresAt

export function networkChange(
  current: TerminalNetworkPolicy,
  input: TerminalNetworkPolicy,
  authority: TerminalAuthority | undefined
) {
  if (!authority?.active)
    throw new TerminalFailure({
      message: "Restore this bot before changing its network settings.",
    })
  if (current.revision !== input.revision)
    throw new TerminalFailure({
      message: "Network settings changed. Reload before saving again.",
    })
  return { revision: current.revision + 1, unrestricted: input.unrestricted }
}
export const authorized = (
  run: CommandRun,
  authority: TerminalAuthority | undefined
) =>
  !!authority?.active &&
  (run.authorityRevision ?? -1) > authority.revokedThrough

export function replayCommand(
  previous: CommandRun | undefined,
  input: CommandInput,
  kind: NonNullable<CommandRun["kind"]>,
  transfer?: CommandRun["transfer"]
) {
  if (
    previous &&
    (previous.command !== input.command ||
      (previous.kind ?? "command") !== kind ||
      JSON.stringify(previous.transfer) !== JSON.stringify(transfer))
  )
    throw new TerminalFailure({
      message: "This command ID already has different input.",
    })
  return previous
}
export function admitCommand(
  input: CommandInput,
  kind: NonNullable<CommandRun["kind"]>,
  transfer: CommandRun["transfer"],
  authority: TerminalAuthority | undefined,
  count: number,
  stopped: boolean,
  networkUnrestricted: boolean,
  now: number
): CommandRun {
  if (!authority?.active || authority.revision <= authority.revokedThrough)
    throw new TerminalFailure({ message: "This bot is not active." })
  if (count >= 500)
    throw new TerminalFailure({
      message: "This bot has reached its 500-command history limit.",
    })
  return {
    ...input,
    authorityRevision: authority.revision,
    networkUnrestricted,
    kind,
    ...(transfer ? { transfer } : {}),
    status: stopped ? "cancelled" : "running",
    output: "",
    exitCode: null,
    error: stopped
      ? "Stopped before dispatch. This command was not executed."
      : null,
    createdAt: now,
    finishedAt: stopped ? now : null,
    savedAt: null,
  }
}
export function finishCommand(
  run: CommandRun,
  result: Pick<CommandRun, "status" | "exitCode" | "error">,
  publishing: boolean,
  allowed: boolean,
  savedAt: number | null,
  now: number
): CommandRun {
  if (run.status !== "running") return run
  if (publishing && !allowed)
    return {
      ...run,
      status: "cancelled",
      exitCode: null,
      error: "Bot archived. Workspace recovery uses the last saved checkpoint.",
      finishedAt: now,
      savedAt: null,
    }
  return { ...run, ...result, finishedAt: now, savedAt }
}
