import { useEffect, useRef } from "react"

import { AVATAR_TYPES } from "@/auth/avatar"
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
import { UserAvatar } from "@/components/user-avatar"

import { useAuthBusy } from "./auth-owner"
import { usePhoto } from "./photo-owner"

export function ProfilePhoto({
  onPendingChange,
}: {
  onPendingChange: (pending: boolean) => void
}) {
  const { data: session, refetch } = authClient.useSession()
  const photo = usePhoto(session?.session.id ?? "signed-out", refetch)
  const pending = !!photo.snapshot && !photo.snapshot.matches("ready")
  const error = photo.snapshot?.context.error ?? ""
  const notice = photo.snapshot?.context.notice ?? ""
  const input = useRef<HTMLInputElement>(null)
  useAuthBusy(pending, onPendingChange)
  useEffect(() => {
    if (!pending && input.current) input.current.value = ""
  }, [pending])
  function save(file?: File) {
    photo.send({ type: "SAVE", file: file ?? null })
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
        <Field data-invalid={!!error} data-disabled={pending || !photo.actor}>
          <FieldLabel htmlFor="profile-photo">Choose a photo</FieldLabel>
          <Input
            id="profile-photo"
            ref={input}
            type="file"
            accept={AVATAR_TYPES.join(",")}
            disabled={pending || !photo.actor}
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
          disabled={pending || !photo.actor || !session.user.image}
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
