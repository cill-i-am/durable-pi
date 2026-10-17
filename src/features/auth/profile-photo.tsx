import { useEffect, useRef, useState } from "react"

import { AVATAR_PATH, AVATAR_TYPES } from "@/auth/avatar"
import { authClient, authFetch } from "@/auth/client"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { UserAvatar } from "@/components/user-avatar"
import { errorMessage } from "@/http/client"

import { prepareAvatar } from "./prepare-avatar"

export function ProfilePhoto({
  onPendingChange,
}: {
  onPendingChange: (pending: boolean) => void
}) {
  const { data: session, refetch } = authClient.useSession()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const input = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  useEffect(() => {
    onPendingChange(pending)
    return () => onPendingChange(false)
  }, [pending, onPendingChange])

  async function save(file?: File) {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError("")
    setNotice("")
    try {
      const photo = file ? await prepareAvatar(file) : undefined
      const response = await authFetch(AVATAR_PATH, {
        method: photo ? "POST" : "DELETE",
        headers: photo ? { "content-type": photo.type } : undefined,
        body: photo,
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) {
        if (response.status === 401)
          throw new Error("Your session has expired. Sign in again.")
        throw new Error(errorMessage(await response.json()))
      }
      await refetch()
      if ((await authClient.getSession()).error)
        throw new Error(
          "Your photo was saved. Reload to see the updated profile."
        )
      setNotice(photo ? "Profile photo updated." : "Profile photo removed.")
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not confirm the photo update. Reload and try again."
      )
    } finally {
      if (input.current) input.current.value = ""
      busy.current = false
      setPending(false)
    }
  }
  if (!session) return null
  return (
    <section
      aria-labelledby="profile-photo-heading"
      aria-busy={pending}
      className="flex flex-col gap-4"
    >
      <div className="flex items-center gap-4">
        <UserAvatar
          name={session.user.name}
          image={session.user.image}
          className="size-16"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id="profile-photo-heading" className="font-medium">
            Your profile photo
          </h3>
          <p className="text-sm text-muted-foreground">
            Shown in your personal workspace.
          </p>
        </div>
      </div>
      <FieldGroup>
        <Field data-invalid={!!error} data-disabled={pending}>
          <FieldLabel htmlFor="profile-photo">Choose a photo</FieldLabel>
          <Input
            id="profile-photo"
            ref={input}
            type="file"
            accept={AVATAR_TYPES.join(",")}
            disabled={pending}
            aria-invalid={!!error}
            aria-describedby="profile-photo-help"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              if (file) void save(file)
            }}
          />
          <FieldDescription id="profile-photo-help">
            JPEG, PNG or WebP, up to 10 MB. Saved as a square with the centre of
            your photo.
          </FieldDescription>
        </Field>
      </FieldGroup>
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={pending || !session.user.image}
          onClick={() => void save()}
        >
          Remove photo
        </Button>
        {pending && (
          <p role="status" className="text-sm text-muted-foreground">
            Updating photo…
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        )}
      </div>
      {error && (
        <Alert role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </section>
  )
}
