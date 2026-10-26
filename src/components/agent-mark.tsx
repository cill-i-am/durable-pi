import { cn } from "cn"

export function AgentMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      aria-hidden="true"
      className={cn("agent-mark", className)}
    >
      <path
        d="M8 9C12 2 25 2 29 8C37 9 39 18 35 23C34 33 28 38 20 35C10 39 3 30 5 24C0 18 3 12 8 9Z"
        fill="currentColor"
      />
      <ellipse cx="15" cy="20" rx="2" ry="3" fill="var(--agent-mark-ink)" />
      <ellipse cx="26" cy="20" rx="2" ry="3" fill="var(--agent-mark-ink)" />
    </svg>
  )
}
