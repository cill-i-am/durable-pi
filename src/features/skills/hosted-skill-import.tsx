import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { useState } from "react"

import type { SaveSkill } from "@/skills/contracts"
import type { SkillSource } from "@/skills/source"

import { useHostedSkill } from "./use-hosted-skill"

export function HostedSkillImport({
  onPreview,
  onCancel,
}: {
  onPreview: (draft: SaveSkill) => void
  onCancel: () => void
}) {
  const [app, setApp] = useState("personal-skills")
  const { providers, selected, catalog, error, busy, event } =
    useHostedSkill(onPreview)
  return (
    <section className="settings-form" aria-label="Import from Executor">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">From Executor</h3>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            event({ type: "CANCEL" })
            onCancel()
          }}
        >
          Cancel
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Read SKILL.md from your connection, then review and save a local copy.
        Referenced files stay on the provider.
      </p>
      {error && (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!providers.length ? (
        <p className="text-sm text-muted-foreground">
          {busy
            ? "Loading connections…"
            : "Add an Executor server in Connections and finish signing in first. It must expose a skills tool."}
        </p>
      ) : (
        <>
          <FieldGroup>
            <Field>
              <FieldLabel>Connection</FieldLabel>
              <div
                className="flex flex-wrap gap-2"
                role="group"
                aria-label="Skill provider"
              >
                {providers.map((tool) => (
                  <Button
                    key={tool.name}
                    variant={selected === tool.name ? "secondary" : "outline"}
                    size="sm"
                    aria-pressed={selected === tool.name}
                    disabled={busy}
                    onClick={() => {
                      event({ type: "PROVIDER", name: tool.name })
                    }}
                  >
                    {tool.connectionName}
                  </Button>
                ))}
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="skill-source-app">App slug</FieldLabel>
              <Input
                id="skill-source-app"
                value={app}
                maxLength={160}
                disabled={busy}
                onChange={(change) => {
                  setApp(change.target.value)
                  event({ type: "CLEAR_CATALOG" })
                }}
              />
            </Field>
          </FieldGroup>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !app.trim()}
            onClick={() => event({ type: "BROWSE", app: app.trim() })}
          >
            {busy ? "Reading…" : "Browse skills"}
          </Button>
          {catalog && (
            <div className="divide-y">
              {!catalog.length && (
                <p className="py-3 text-sm text-muted-foreground">
                  No skills are available in this app.
                </p>
              )}
              {catalog.map((skill) => (
                <article
                  key={JSON.stringify([
                    skill.app.id,
                    skill.name,
                    skill.deployment,
                    skill.revision,
                    skill.profile,
                  ])}
                  className="flex items-start gap-3 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <h4 className="text-sm font-medium break-words">
                      {skill.name}
                    </h4>
                    <p className="line-clamp-3 text-xs text-muted-foreground">
                      {skill.description}
                    </p>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      Revision {skill.revision.slice(0, 12)}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      event({ type: "READ", skill, id: crypto.randomUUID() })
                    }
                  >
                    Preview
                  </Button>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}

export function SkillSourceLabel({ source }: { source?: SkillSource }) {
  if (!source) return null
  const references = source.files.filter((file) => file !== "SKILL.md")
  return (
    <details className="text-xs break-words text-muted-foreground">
      <summary className="cursor-pointer">
        Local copy from {source.connectionName} · {source.app.name}
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <p>
          Source: {source.name} · revision {source.revision}. This copy can be
          edited locally.
        </p>
        {!!references.length && (
          <>
            <p>
              {references.length} reference{" "}
              {references.length === 1 ? "file remains" : "files remain"} on the
              provider. To let this bot read them, select the connection’s
              skills tool in Connections and review its access in Tool access.
            </p>
            <ul className="list-inside list-disc">
              {references.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </details>
  )
}
