import { cn } from "cn"

/** The agent mark from the approved Paper workroom. Labels live beside the mark. */
export function AgentMark({
  className,
  tone = "primary",
}: {
  className?: string
  tone?: "primary" | "peach" | "lilac" | "blue"
}) {
  return (
    <svg
      viewBox="0 0 40 40"
      aria-hidden="true"
      className={cn("agent-mark", className)}
      data-tone={tone}
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

/** Stable presentation only; a color never implies shared data or permissions. */
export function agentTone(id: string) {
  if (id === "home") return "primary" as const
  const tones = ["primary", "peach", "lilac", "blue"] as const
  let hash = 0
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return tones[hash % tones.length]
}
