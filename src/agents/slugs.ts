import { Schema } from "effect"

export const AgentSlug = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(80)
)
export type AgentSlug = typeof AgentSlug.Type

/** IDs and collection routes occupy the same URL segment as slugs. */
export function allocateAgentSlug(name: string, occupied: Iterable<string>) {
  const taken = new Set(["home", "new", "archived", ...occupied])
  const base =
    name
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 68)
      .replace(/-$/, "") || "agent"
  let slug = base
  for (
    let suffix = 2;
    taken.has(slug) || /^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(slug);
    suffix++
  )
    slug = `${base}-${suffix}`
  return slug
}
