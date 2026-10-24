import { useId } from "react"

import type {
  AppAction,
  AppBlock,
  AppDefinition,
  AppState,
} from "@/apps/contracts"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"

import { useAppForm } from "./use-app-form"
import { WebCanvas } from "./web-canvas"

export function AppCanvas(props: Parameters<typeof AppCanvasView>[0]) {
  return (
    <AppCanvasView
      key={`${props.agentId}/${props.id}/${props.version}`}
      {...props}
    />
  )
}
function AppCanvasView({
  definition,
  agentId,
  id,
  version,
  state,
  revision,
  disabled,
  onAction,
}: {
  definition: AppDefinition
  agentId: string
  id: string
  version: number
  state: AppState
  revision: number
  disabled: boolean
  onAction: (action: AppAction, expectedRevision?: number) => Promise<boolean>
}) {
  const prefix = useId()
  return (
    <article
      className="flex min-w-0 flex-col gap-6"
      aria-label={definition.title}
    >
      <header className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold break-words">
          {definition.title}
        </h2>
        {definition.description && (
          <p className="text-sm break-words text-muted-foreground">
            {definition.description}
          </p>
        )}
      </header>
      <Separator />
      {definition.blocks.map((block) => {
        if (block.type === "web")
          return (
            <WebCanvas
              key={block.id}
              agentId={agentId}
              id={id}
              version={version}
              revision={revision}
              blockId={block.id}
              title={definition.title}
              disabled={disabled}
              onAction={onAction}
            />
          )
        if (block.type === "text")
          return (
            <p
              key={block.id}
              className="text-sm break-words whitespace-pre-wrap"
            >
              {block.text}
            </p>
          )
        if (block.type === "metric")
          return (
            <dl key={block.id} className="flex flex-col gap-1">
              <dt className="text-xs break-words text-muted-foreground">
                {block.label}
              </dt>
              <dd className="text-2xl font-semibold break-words">
                {block.value}
              </dd>
            </dl>
          )
        if (block.type === "table")
          return (
            <section
              key={block.id}
              className="flex min-w-0 flex-col gap-2"
              aria-label={block.title}
            >
              <h3 className="text-sm font-medium break-words">{block.title}</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    {block.columns.map((column, i) => (
                      <TableHead key={i}>{column}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {block.rows.map((row, i) => (
                    <TableRow key={i}>
                      {row.map((cell, j) => (
                        <TableCell key={j}>{cell}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          )
        if (block.type === "checklist")
          return (
            <FieldSet key={block.id} disabled={disabled}>
              <FieldLegend>{block.title}</FieldLegend>
              <FieldGroup>
                {block.items.map((item) => (
                  <Field key={item.id} orientation="horizontal">
                    <Checkbox
                      id={`${prefix}-${block.id}-${item.id}`}
                      checked={state.checks[`${block.id}/${item.id}`] ?? false}
                      disabled={disabled}
                      onCheckedChange={(checked) =>
                        void onAction({
                          type: "check",
                          blockId: block.id,
                          itemId: item.id,
                          checked: !!checked,
                        })
                      }
                    />
                    <FieldLabel
                      htmlFor={`${prefix}-${block.id}-${item.id}`}
                      className="min-w-0 break-words"
                    >
                      {item.label}
                    </FieldLabel>
                  </Field>
                ))}
              </FieldGroup>
            </FieldSet>
          )
        return (
          <AppForm
            key={block.id}
            block={block}
            saved={state.forms[block.id] ?? {}}
            revision={revision}
            disabled={disabled}
            onAction={onAction}
          />
        )
      })}
    </article>
  )
}
function AppForm({
  block,
  saved,
  revision,
  disabled,
  onAction,
}: {
  block: Extract<AppBlock, { type: "form" }>
  saved: Record<string, string>
  revision: number
  disabled: boolean
  onAction: (action: AppAction, expectedRevision?: number) => Promise<boolean>
}) {
  const form = useAppForm(block.id, saved, revision, disabled, onAction)
  const { values, conflict, submitted } = form
  const prefix = useId()
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (conflict) return
        form.submit()
      }}
    >
      <FieldSet disabled={disabled}>
        <FieldLegend>{block.title}</FieldLegend>
        <FieldGroup>
          {block.fields.map((field) => {
            const Control = field.multiline ? Textarea : Input
            return (
              <Field key={field.id} data-disabled={disabled}>
                <FieldLabel htmlFor={`${prefix}-${field.id}`}>
                  {field.label}
                  {field.required ? " *" : ""}
                </FieldLabel>
                <Control
                  id={`${prefix}-${field.id}`}
                  value={values[field.id] ?? ""}
                  maxLength={1000}
                  required={field.required}
                  disabled={disabled}
                  onChange={(event) => form.edit(field.id, event.target.value)}
                />
              </Field>
            )
          })}
          {conflict && (
            <Alert>
              <AlertDescription>
                The app changed while you were editing. Your unsaved entries are
                still here.
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={form.useSaved}
                  >
                    Use saved values
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={form.keepEdits}
                  >
                    Keep my edits
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={disabled || conflict || form.saving}>
            {block.submitLabel}
          </Button>
          {submitted && (
            <p className="text-xs text-muted-foreground" role="status">
              Saved. An update is queued for this bot.
            </p>
          )}
        </FieldGroup>
      </FieldSet>
    </form>
  )
}
