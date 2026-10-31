import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { KeyRound } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { authClient } from "@/auth/client"

import { useAuthBusy } from "./auth-owner"
import { supportsPasskeys } from "./passkey-errors"
import { usePasskeyActor } from "./passkeys-owner"
import type { PasskeyEditor as Editor } from "./passkeys.machine"

type Props = { disabled: boolean; onBusyChange: (busy: boolean) => void }
function usePasskeys({ disabled, onBusyChange }: Props) {
  const { data: session } = authClient.useSession()
  const [available, setAvailable] = useState(false)
  const [name, setName] = useState("")
  const [nameInvalid, setNameInvalid] = useState(false)
  const auth = usePasskeyActor(session?.session.id ?? "signed-out", {
    disabled,
    available,
  })
  const state = auth.snapshot
  const {
    keys,
    editor,
    error,
    notice,
    freshSignIn,
    readFailed,
    loading,
    pending,
  } = passkeyProjection(state)
  useEffect(() => setAvailable(supportsPasskeys()), [])
  const dispatch = auth.send
  useEffect(() => {
    dispatch({ type: "VIEW", disabled, available })
  }, [dispatch, disabled, available])
  useAuthBusy(pending, onBusyChange)
  const nameInput = useRef<HTMLInputElement>(null)
  const cancelRemoval = useRef<HTMLButtonElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  const restoreFocus = useRef(false)
  const refresh = () => auth.send({ type: "REFRESH" })
  useEffect(() => {
    if (editor?.kind === "remove") cancelRemoval.current?.focus()
    else if (editor) nameInput.current?.focus()
  }, [editor])
  useEffect(() => {
    if (editor || pending || loading || disabled || !restoreFocus.current)
      return
    restoreFocus.current = false
    const previous = opener.current
    const target =
      previous?.isConnected && !previous.disabled
        ? previous
        : addButton.current && !addButton.current.disabled
          ? addButton.current
          : heading.current
    target?.focus()
    // Drawer restores its popup on the next frame when the focused editor is
    // removed. Restore the opener after that bounded native restoration, only
    // while this same editor remains closed and the user has not moved focus.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const state = auth.actor?.getSnapshot()
        const active = document.activeElement
        if (
          state?.status === "active" &&
          state.context.editor === null &&
          target?.isConnected &&
          !(target instanceof HTMLButtonElement && target.disabled) &&
          (active === document.body ||
            active === target.closest('[role="dialog"]'))
        )
          target.focus()
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [editor, pending, loading, disabled, auth.actor])
  function edit(value: Editor, target: HTMLButtonElement) {
    opener.current = target
    auth.send({ type: "EDIT", editor: value })
    setName(value.kind === "rename" ? (value.key.name ?? "") : "")
    setNameInvalid(false)
  }
  function closeEditor() {
    auth.send({ type: "CANCEL" })
    restoreFocus.current = true
  }
  function save(event?: React.SubmitEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (editor?.kind !== "remove" && !name.trim()) {
      setNameInvalid(true)
      nameInput.current?.focus()
      return
    }
    restoreFocus.current = true
    auth.send({ type: "SAVE", name })
  }
  const locked = disabled || pending || !auth.actor
  return {
    keys,
    loading,
    pending,
    available,
    editor,
    name,
    error,
    notice,
    freshSignIn,
    readFailed,
    nameInvalid,
    heading,
    nameInput,
    addButton,
    cancelRemoval,
    refresh,
    edit,
    closeEditor,
    save,
    locked,
    setName,
    setNameInvalid,
    signOut: () => auth.send({ type: "SIGN_OUT" }),
  }
}

function passkeyProjection(
  state: ReturnType<typeof usePasskeyActor>["snapshot"]
) {
  const keys = state?.context.keys ?? []
  const editor = state?.context.editor ?? null
  const error = state?.context.error ?? ""
  const notice = state?.context.notice ?? ""
  const freshSignIn = state?.context.freshSignIn ?? false
  const readFailed = state?.context.readFailed ?? false
  const loading = !state || state.matches("loading")
  const pending =
    state?.matches("saving") ||
    state?.matches("signingOut") ||
    state?.matches("signedOut") ||
    false
  return {
    keys,
    editor,
    error,
    notice,
    freshSignIn,
    readFailed,
    loading,
    pending,
  }
}

type View = ReturnType<typeof usePasskeys>

export function PasskeySettings(props: Props) {
  const view = usePasskeys(props)
  const {
    keys,
    loading,
    pending,
    available,
    editor,
    error,
    notice,
    freshSignIn,
    readFailed,
    heading,
    addButton,
    refresh,
    edit,
    locked,
  } = view
  return (
    <section
      className="passkey-settings flex flex-col gap-4"
      aria-labelledby="passkeys-heading"
      aria-busy={loading}
    >
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <h2
            ref={heading}
            tabIndex={-1}
            id="passkeys-heading"
            className="text-md font-semibold"
          >
            Passkeys
          </h2>
          <Button
            ref={addButton}
            disabled={locked || loading || readFailed || !available}
            onClick={(event) => edit({ kind: "add" }, event.currentTarget)}
          >
            Add passkey
          </Button>
        </div>
        <p className="text-sm leading-6 text-muted-foreground">
          Sign in with your fingerprint, face or device PIN. Your password
          remains available.
        </p>
      </header>
      {loading && (
        <p className="text-sm text-muted-foreground">Loading passkeys…</p>
      )}
      {!loading && !error && keys.length === 0 && (
        <p className="text-sm leading-6 text-muted-foreground">
          No passkeys yet. Add a passkey to sign in with your device.
        </p>
      )}
      {!available && (
        <p className="text-sm leading-6 text-muted-foreground">
          This browser cannot create passkeys. You can manage existing keys
          here, or use a supported browser to add one.
        </p>
      )}
      <PasskeyRows view={view} />
      <PasskeyEditor view={view} />
      <p role="status" className="text-sm leading-6 text-muted-foreground">
        {pending && editor?.kind === "add"
          ? "Confirm passkey setup on your device."
          : notice}
      </p>
      {error && (
        <Alert role="alert">
          <AlertDescription>
            {error}
            {freshSignIn && (
              <Button variant="link" disabled={locked} onClick={view.signOut}>
                Sign out and sign in again
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {!pending && error && (
        <div>
          <Button
            variant="outline"
            disabled={props.disabled || loading}
            onClick={() => void refresh()}
          >
            Refresh passkeys
          </Button>
        </div>
      )}
    </section>
  )
}

function PasskeyRows({ view }: { view: View }) {
  const { keys, locked, readFailed, loading, edit } = view
  return (
    <ul className="divide-y">
      {keys.map((key) => (
        <li key={key.id} className="flex flex-wrap items-center gap-4 py-4">
          <KeyRound className="size-5 shrink-0 text-muted-foreground max-sm:hidden" />
          <div className="min-w-0 flex-1 basis-40 break-words">
            <p className="text-sm font-medium">{key.name || "Passkey"}</p>
            {key.createdAt && (
              <p className="text-xs leading-5 text-muted-foreground">
                Added{" "}
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: "long",
                }).format(new Date(key.createdAt))}
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-2 max-sm:w-full">
            <Button
              variant="ghost"
              disabled={locked || readFailed || loading}
              aria-label={`Rename ${key.name || "passkey"}`}
              onClick={(event) =>
                edit({ kind: "rename", key }, event.currentTarget)
              }
            >
              Rename
            </Button>
            <Button
              variant="ghost"
              disabled={locked || readFailed || loading}
              aria-label={`Remove ${key.name || "passkey"}`}
              onClick={(event) =>
                edit({ kind: "remove", key }, event.currentTarget)
              }
            >
              Remove
            </Button>
          </div>
        </li>
      ))}
    </ul>
  )
}

function PasskeyEditor({ view }: { view: View }) {
  const {
    editor,
    cancelRemoval,
    locked,
    readFailed,
    save,
    closeEditor,
    pending,
    nameInvalid,
    nameInput,
    name,
    setName,
    setNameInvalid,
  } = view
  return editor?.kind === "remove" ? (
    <section
      className="flex flex-col gap-4 rounded-lg border p-5"
      aria-label="Confirm passkey removal"
    >
      <h3 className="font-semibold break-words">
        Remove “{editor.key.name || "Passkey"}”?
      </h3>
      <p className="text-sm leading-6 text-muted-foreground">
        You won’t be able to sign in with this passkey. Your password and other
        passkeys remain available. Existing browsers stay signed in.
      </p>
      <div className="flex flex-wrap justify-end gap-3">
        <Button
          ref={cancelRemoval}
          variant="outline"
          disabled={locked}
          onClick={closeEditor}
        >
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={locked || readFailed}
          onClick={() => void save()}
        >
          {pending ? "Removing…" : "Remove passkey"}
        </Button>
      </div>
    </section>
  ) : editor ? (
    <form
      onSubmit={(event) => void save(event)}
      className="flex flex-col gap-4 rounded-lg border p-5"
      aria-label={editor.kind === "add" ? "Add a passkey" : "Rename passkey"}
    >
      <h3 className="font-semibold">
        {editor.kind === "add" ? "Add a passkey" : "Rename passkey"}
      </h3>
      {editor.kind === "add" && (
        <p className="text-sm leading-6 text-muted-foreground">
          Your device will ask you to confirm. Your fingerprint, face or PIN
          stays on your device.
        </p>
      )}
      <FieldGroup>
        <Field data-invalid={nameInvalid}>
          <FieldLabel htmlFor="passkey-name">Passkey name</FieldLabel>
          <Input
            ref={nameInput}
            id="passkey-name"
            name="passkeyName"
            autoComplete="off"
            placeholder="My phone"
            value={name}
            aria-invalid={nameInvalid}
            aria-describedby={nameInvalid ? "passkey-name-error" : undefined}
            onChange={(event) => {
              setName(event.target.value)
              setNameInvalid(false)
            }}
            required
            minLength={1}
            maxLength={100}
            disabled={locked}
          />
          <FieldDescription>
            Choose a name you’ll recognise later.
          </FieldDescription>
          {nameInvalid && (
            <p id="passkey-name-error" className="text-sm text-destructive">
              Enter a name for this passkey.
            </p>
          )}
        </Field>
      </FieldGroup>
      <div className="flex flex-wrap justify-end gap-3">
        <Button variant="outline" disabled={locked} onClick={closeEditor}>
          Cancel
        </Button>
        <Button type="submit" disabled={locked || readFailed}>
          {pending
            ? "Waiting…"
            : editor.kind === "add"
              ? "Continue on this device"
              : "Save name"}
        </Button>
      </div>
    </form>
  ) : null
}
