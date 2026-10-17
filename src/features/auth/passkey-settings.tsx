import { Schema } from "effect"
import { KeyRound } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { authClient } from "@/auth/client"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"

import {
  passkeyError,
  passkeyErrorCode,
  supportsPasskeys,
} from "./passkey-sign-in"

const SavedPasskey = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Date]))
  ),
})
type Passkey = typeof SavedPasskey.Type
type Editor = { kind: "add" } | { kind: "rename" | "remove"; key: Passkey }

type Props = { disabled: boolean; onBusyChange: (busy: boolean) => void }
function usePasskeys({ disabled, onBusyChange }: Props) {
  const [keys, setKeys] = useState<readonly Passkey[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [available, setAvailable] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [name, setName] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [freshSignIn, setFreshSignIn] = useState(false)
  const [readFailed, setReadFailed] = useState(false)
  const [nameInvalid, setNameInvalid] = useState(false)
  const generation = useRef(0)
  const nameInput = useRef<HTMLInputElement>(null)
  const cancelRemoval = useRef<HTMLButtonElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  const restoreFocus = useRef(false)
  const refresh = useCallback(async () => {
    const request = ++generation.current
    setLoading(true)
    try {
      const result = await authClient.passkey.listUserPasskeys()
      if (request !== generation.current) return
      if (result.error) {
        setReadFailed(true)
        setKeys([])
        setError(
          "Could not load passkeys. Refresh the list before making changes."
        )
      } else {
        setReadFailed(false)
        setKeys(
          Schema.decodeUnknownSync(Schema.Array(SavedPasskey))(
            result.data ?? []
          )
        )
        setError("")
      }
    } catch {
      if (request === generation.current) {
        setReadFailed(true)
        setError(
          "Could not load passkeys. Refresh the list before making changes."
        )
      }
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    setAvailable(supportsPasskeys())
    void refresh()
    return () => {
      // oxlint-disable-next-line react/exhaustive-deps -- Invalidate pending reads on unmount.
      generation.current++
    }
  }, [refresh])
  useEffect(() => {
    if (editor?.kind === "remove") cancelRemoval.current?.focus()
    else if (editor) nameInput.current?.focus()
  }, [editor])
  useEffect(() => {
    if (editor || pending || loading || !restoreFocus.current) return
    restoreFocus.current = false
    const target = opener.current
    if (target?.isConnected && !target.disabled) target.focus()
    else if (addButton.current && !addButton.current.disabled)
      addButton.current.focus()
    else heading.current?.focus()
  }, [editor, pending, loading])
  function edit(value: Editor, target: HTMLButtonElement) {
    opener.current = target
    setEditor(value)
    setName(value.kind === "rename" ? (value.key.name ?? "") : "")
    setNotice("")
    setError("")
    setFreshSignIn(false)
    setNameInvalid(false)
  }
  function closeEditor() {
    setEditor(null)
    restoreFocus.current = true
  }
  async function save(event?: React.SubmitEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (!editor || pending || disabled) return
    if (editor.kind !== "remove" && !name.trim()) {
      setNameInvalid(true)
      nameInput.current?.focus()
      return
    }
    setPending(true)
    onBusyChange(true)
    setError("")
    setNotice("")
    try {
      const result =
        editor.kind === "add"
          ? await authClient.passkey.addPasskey({ name: name.trim() })
          : editor.kind === "rename"
            ? await authClient.passkey.updatePasskey({
                id: editor.key.id,
                name: name.trim(),
              })
            : await authClient.passkey.deletePasskey({ id: editor.key.id })
      if (result.error) {
        setError(passkeyError(result.error))
        setFreshSignIn(passkeyErrorCode(result.error) === "SESSION_NOT_FRESH")
      } else if (!result.data) {
        setReadFailed(true)
        setError(
          "Could not confirm the change. Refresh the list before trying again."
        )
      } else {
        setNotice(
          editor.kind === "add"
            ? "Passkey added. You can use it next time you sign in."
            : editor.kind === "rename"
              ? "Passkey renamed."
              : "Passkey removed. Existing browser sessions stay signed in."
        )
        closeEditor()
        await refresh()
      }
    } catch {
      setReadFailed(true)
      setError(
        "Could not confirm the change. Refresh the list before trying again."
      )
    } finally {
      setPending(false)
      onBusyChange(false)
    }
  }
  const locked = disabled || pending
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
            className="text-xl font-semibold"
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
              <Button variant="link" onClick={() => void authClient.signOut()}>
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
