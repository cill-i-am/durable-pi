import { ArrowDown, ArrowUp, Eye, EyeOff } from "lucide-react"
import { useState } from "react"

import type { BrowserAction, BrowserState } from "@/browser/contracts"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

import { useBrowserPreview } from "./browser-preview"

export function BrowserControls({
  agentId,
  state,
  busy,
  act,
  refresh,
}: {
  agentId: string
  state: BrowserState
  busy: boolean
  act: (action: BrowserAction) => Promise<boolean>
  refresh: () => void
}) {
  const [text, setText] = useState("")
  const [visible, setVisible] = useState(false)
  const preview = useBrowserPreview(agentId, state, refresh)
  const blocked = busy || state.status !== "ready" || !preview.ready
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        You’re in control. Bot browser tools are paused.
      </p>
      {preview.active && state.hasScreenshot && !preview.failed && (
        <button
          type="button"
          data-base-ui-swipe-ignore=""
          disabled={blocked}
          className="block w-full overflow-hidden rounded-md border bg-white text-left focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait"
          aria-label="Remote browser: click a point, or activate with the keyboard to focus the next field"
          onClick={(event) => {
            if (event.detail === 0) {
              void act({ kind: "key", key: "Tab" })
              return
            }
            const rect = event.currentTarget.getBoundingClientRect()
            void act({
              kind: "click",
              x: Math.max(
                0,
                Math.min(
                  1023,
                  Math.floor(((event.clientX - rect.left) / rect.width) * 1024)
                )
              ),
              y: Math.max(
                0,
                Math.min(
                  767,
                  Math.floor(((event.clientY - rect.top) / rect.height) * 768)
                )
              ),
            })
          }}
        >
          <img
            key={preview.key}
            onLoad={preview.loaded}
            draggable={false}
            className="block aspect-[4/3] w-full"
            src={preview.src}
            alt="Remote page; use the controls below for keyboard interaction"
            onError={preview.failedToLoad}
          />
        </button>
      )}
      {(!state.hasScreenshot || preview.failed) && (
        <p className="rounded-md border p-3 text-sm text-muted-foreground">
          Refresh the view to load a current preview before interacting.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Click the page to focus a field. Tab field moves the remote focus; Type
        inserts text. What you type here is not added to chat. The bot can
        inspect the page after you return control.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {(
          [
            ["Tab", "Tab field"],
            ["Enter", "Enter"],
            ["SelectAll", "Select all"],
            ["Backspace", "Backspace"],
            ["Escape", "Escape"],
          ] as const
        ).map(([key, label]) => (
          <Button
            key={key}
            size="xs"
            variant="outline"
            disabled={blocked}
            onClick={() => void act({ kind: "key", key })}
          >
            {label}
          </Button>
        ))}
        <Button
          size="icon-xs"
          variant="outline"
          aria-label="Scroll remote page up"
          disabled={blocked}
          onClick={() => void act({ kind: "scroll", deltaY: -512 })}
        >
          <ArrowUp />
        </Button>
        <Button
          size="icon-xs"
          variant="outline"
          aria-label="Scroll remote page down"
          disabled={blocked}
          onClick={() => void act({ kind: "scroll", deltaY: 512 })}
        >
          <ArrowDown />
        </Button>
      </div>
      {state.page?.focus && (
        <p className="text-xs text-muted-foreground">
          Focused: {state.page.focus.label} ({state.page.focus.kind}
          {state.page.focus.secret ? ", sensitive" : ""}).
        </p>
      )}
      <form
        className="flex items-end gap-2"
        onSubmit={async (event) => {
          event.preventDefault()
          if (!text || blocked) return
          const input = text
          setText("")
          await act({ kind: "type", text: input })
        }}
      >
        <Field className="min-w-0 flex-1">
          <FieldLabel htmlFor="remote-browser-input">
            Type into the focused field
          </FieldLabel>
          <div className="relative">
            <Input
              id="remote-browser-input"
              type={visible ? "text" : "password"}
              autoComplete="off"
              data-1p-ignore="true"
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={2000}
              disabled={blocked}
              className="pr-10"
            />
            <Button
              className="absolute top-0.5 right-1"
              size="icon-sm"
              variant="ghost"
              aria-label={visible ? "Hide input" : "Show input"}
              onClick={() => setVisible((value) => !value)}
            >
              {visible ? <EyeOff /> : <Eye />}
            </Button>
          </div>
        </Field>
        <Button type="submit" size="sm" disabled={blocked || !text}>
          Type
        </Button>
      </form>
    </div>
  )
}
