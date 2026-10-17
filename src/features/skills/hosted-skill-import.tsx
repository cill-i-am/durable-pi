import { Schema } from "effect"
import { useEffect, useRef, useState } from "react"

import { ConnectionList, type RemoteTool } from "@/access/connections"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { agentApi } from "@/http/client"
import { SkillBody, SkillName, type SaveSkill } from "@/skills/contracts"
import {
  HostedSkillCatalog,
  SkillSource,
  type HostedSkill,
} from "@/skills/source"

const Preview = Schema.Struct({
  name: SkillName,
  body: SkillBody,
  source: SkillSource,
})
export function HostedSkillImport({
  onPreview,
  onCancel,
}: {
  onPreview: (draft: SaveSkill) => void
  onCancel: () => void
}) {
  const [providers, setProviders] = useState<readonly RemoteTool[]>([])
  const [selected, setSelected] = useState("")
  const [app, setApp] = useState("personal-skills")
  const [catalog, setCatalog] = useState<readonly HostedSkill[] | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(true)
  const request = useRef(0)
  const locked = useRef(false)
  useEffect(() => {
    const version = ++request.current
    void agentApi("home")("connections")
      .then(Schema.decodeUnknownSync(ConnectionList))
      .then((result) => {
        if (version !== request.current) return
        const tools = result.connections
          .filter((connection) => connection.status === "ready")
          .flatMap((connection) =>
            connection.tools.filter((tool) => tool.remoteName === "skills")
          )
        setProviders(tools)
        setSelected(tools[0]?.name ?? "")
      })
      .catch(() => {
        if (version === request.current)
          setError(
            "Could not load your connections. Close this import and retry."
          )
      })
      .finally(() => {
        if (version === request.current) setBusy(false)
      })
    return () => {
      // oxlint-disable-next-line react/exhaustive-deps -- Advance the live request generation so all pending responses become stale.
      request.current++
    }
  }, [])
  async function load(skill?: HostedSkill) {
    if (locked.current || !selected) return
    locked.current = true
    const version = ++request.current
    setBusy(true)
    setError("")
    try {
      if (skill) {
        const preview = Schema.decodeUnknownSync(Preview)(
          await agentApi("home")("skills/import/read", {
            toolName: selected,
            skill,
          })
        )
        if (version === request.current)
          onPreview({
            id: crypto.randomUUID(),
            expectedRevision: 0,
            ...preview,
          })
      } else {
        const loaded = Schema.decodeUnknownSync(HostedSkillCatalog)(
          await agentApi("home")("skills/import/list", {
            toolName: selected,
            app: app.trim(),
          })
        )
        if (version === request.current) setCatalog(loaded.skills)
      }
    } catch (cause) {
      if (version === request.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not read this skill. Nothing was saved."
        )
    } finally {
      locked.current = false
      if (version === request.current) setBusy(false)
    }
  }
  return (
    <section
      className="flex flex-col gap-4 rounded-lg border p-4"
      aria-label="Import from Executor"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">From Executor</h3>
        <Button size="xs" variant="ghost" onClick={onCancel}>
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
            : "Add an Executor server in Connect and finish signing in first. It must expose a skills tool."}
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
                      setSelected(tool.name)
                      setCatalog(null)
                    }}
                  >
                    {tool.connectionName}
                  </Button>
                ))}
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="skill-source-app">App slug or ID</FieldLabel>
              <Input
                id="skill-source-app"
                value={app}
                maxLength={160}
                disabled={busy}
                onChange={(event) => {
                  setApp(event.target.value)
                  setCatalog(null)
                }}
              />
            </Field>
          </FieldGroup>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !app.trim()}
            onClick={() => void load()}
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
                    onClick={() => void load(skill)}
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
              skills tool in Connect and review its access in Tools.
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
