import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { useIsMobile } from "@workspace/ui/hooks/use-mobile"
import { Effect, Fiber } from "effect"
import {
  ArrowUpRight,
  Check,
  LockKeyhole,
  MoreHorizontal,
  Plus,
} from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { authClient } from "@/auth/client"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import type { FamilyInvitation, FamilyMember } from "@/family/contracts"

import { useFamily } from "./context"
import { makeFamilyChange } from "./family-change-owner"
import { familyChangeMachine, type FamilyChange } from "./family-change.machine"

export function FamilySettings({
  onPendingChange,
  onModelAccess,
}: {
  onPendingChange: (pending: boolean) => void
  onModelAccess: () => void
}) {
  const { family, refresh, current } = useFamily()
  const authority = `${family.id}:${family.members.find((member) => member.role === "owner")?.id}`
  const [removing, setRemoving] = useState<typeof FamilyMember.Type | null>(
    null
  )
  const resource = useRef<Effect.Success<
    ReturnType<typeof makeFamilyChange>
  > | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<
    ReturnType<typeof familyChangeMachine>
  > | null>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const value = yield* makeFamilyChange({
          authorized: () => {
            const latest = current()
            return (
              latest?.role === "owner" &&
              `${latest.id}:${latest.members.find((member) => member.role === "owner")?.id}` ===
                authority
            )
          },
          change: async (command) => {
            const latest = current()!
            const result =
              command.kind === "invite" || command.kind === "resend"
                ? await authClient.organization.inviteMember({
                    email: command.email,
                    organizationId: latest.id,
                    role: "member",
                    ...(command.kind === "resend" ? { resend: true } : {}),
                  })
                : command.kind === "cancel"
                  ? await authClient.organization.cancelInvitation({
                      invitationId: command.id,
                    })
                  : await authClient.organization.removeMember({
                      memberIdOrEmail: command.id,
                      organizationId: latest.id,
                    })
            if (result.error)
              throw new Error(
                result.error.message || "Could not update family access."
              )
          },
          refresh,
        })
        if (!mounted) {
          value.revoke()
          return
        }
        resource.current = value
        const subscription = value.actor.subscribe((state) => {
          if (mounted) setSnapshot(state)
        })
        setSnapshot(value.actor.getSnapshot())
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => subscription.unsubscribe())
        )
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      resource.current?.revoke()
      resource.current = null
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [authority, current, refresh])
  const { pending, error, notice, command, removed } = changeView(
    snapshot,
    removing
  )
  const invite = command?.kind === "invite" ? command : null
  const owner = family.role === "owner"
  useEffect(() => {
    onPendingChange(pending)
    return () => onPendingChange(false)
  }, [pending, onPendingChange])

  function change(command: FamilyChange) {
    resource.current?.actor.send({ type: "CHANGE", command })
  }
  function reset() {
    resource.current?.actor.send({ type: "RESET" })
  }

  return (
    <section className="settings-section family-settings" aria-label="Family">
      <header className="settings-section-heading">
        <h2>Family</h2>
        <p>One family. A private space for each person.</p>
      </header>
      <div className="settings-section-body">
        {!invite && error && (
          <Alert role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div role="status" className="family-notice">
          {!invite && notice && (
            <>
              <Check />
              {notice}
            </>
          )}
        </div>
        <section aria-labelledby="family-people">
          <div className="family-section-label">
            <h3 id="family-people">People</h3>
            <span>
              {family.members.length}{" "}
              {family.members.length === 1 ? "person" : "people"}
            </span>
          </div>
          <ul>
            {family.members.map((person) => (
              <li className="family-person" key={person.id}>
                <span className="family-avatar" aria-hidden="true">
                  {person.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="family-person-name">
                  <strong>{person.name}</strong>
                  <span>{person.email}</span>
                </div>
                <Badge variant="secondary">
                  {person.role === "owner" ? "Admin" : "Member"}
                </Badge>
                {owner && person.role !== "owner" && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Manage ${person.name}`}
                          disabled={pending}
                        />
                      }
                    >
                      <MoreHorizontal />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      mobileTitle={`Manage ${person.name}`}
                    >
                      <DropdownMenuGroup>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => {
                            reset()
                            setRemoving(person)
                          }}
                        >
                          Remove from family
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </li>
            ))}
          </ul>
        </section>
        {owner && (
          <FamilyInvitations
            invitations={family.invitations}
            pending={pending}
            invite={invite}
            error={error}
            notice={notice}
            change={change}
            reset={reset}
          />
        )}
        <section className="family-model-row" aria-labelledby="family-model">
          <div>
            <h3 id="family-model">Shared model access</h3>
            <p>ChatGPT · Provided by {owner ? "you" : family.ownerName}</p>
          </div>
          <Button variant="outline" onClick={onModelAccess}>
            Model access
            <ArrowUpRight />
          </Button>
        </section>
        <div className="family-privacy">
          <LockKeyhole />
          <div>
            <h3>Your work stays yours</h3>
            <p>
              Everyone’s chats, agents, memory, files and connected accounts
              stay private. Family admins manage access and invitations. They
              can’t open another person’s work.
            </p>
          </div>
        </div>
        {!owner && (
          <p className="settings-description">
            {family.ownerName} manages family invitations and the shared ChatGPT
            connection.
          </p>
        )}
      </div>
      <AlertDialog
        open={!!removing && !removed}
        dismissible={!pending}
        onOpenChange={(open) => {
          if (!open && !pending) setRemoving(null)
        }}
      >
        <AlertDialogContent initialFocus={cancel}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removing?.name} from the family?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They’ll lose access to Pi and the shared ChatGPT connection. Their
              routines and background work will stop. Their private work will be
              retained, and you won’t be able to open it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <Alert role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <Button
              ref={cancel}
              variant="outline"
              disabled={pending}
              onClick={() => setRemoving(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                if (removing)
                  change({
                    kind: "remove",
                    id: removing.id,
                    name: removing.name,
                  })
              }}
            >
              {pending ? "Removing…" : "Remove from family"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function changeView(
  snapshot: SnapshotFrom<ReturnType<typeof familyChangeMachine>> | null,
  removing: typeof FamilyMember.Type | null
) {
  const pending = !snapshot || !snapshot.matches("idle")
  const error = snapshot?.context.error ?? ""
  const notice = snapshot?.context.notice ?? ""
  const command = snapshot?.context.command
  const removed =
    !!notice && command?.kind === "remove" && command.id === removing?.id
  return { pending, error, notice, command, removed }
}

function FamilyInvitations({
  invitations,
  pending,
  invite,
  error,
  notice,
  change,
  reset,
}: {
  invitations: readonly (typeof FamilyInvitation.Type)[]
  pending: boolean
  invite: Extract<FamilyChange, { kind: "invite" }> | null
  error: string
  notice: string
  change: (command: FamilyChange) => void
  reset: () => void
}) {
  const mobile = useIsMobile()
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState("")
  const inviteNotice = invite && !pending ? notice : ""
  const inviteError = invite && !pending ? error : ""
  useEffect(() => {
    if (inviteNotice) setInviteEmail("")
  }, [inviteNotice])
  useEffect(() => {
    if (!mobile) setInviteOpen(false)
  }, [mobile])

  const failedDelivery =
    invite &&
    invitations.some(
      (item) =>
        item.delivery === "failed" &&
        item.email.toLowerCase() === invite.email.toLowerCase()
    )
  const inviteForm = {
    email: inviteEmail,
    pending,
    sending: pending && !!invite,
    error:
      inviteError && failedDelivery
        ? `${inviteError} Use Resend in Invitations to try again.`
        : inviteError,
    onEmailChange(email: string) {
      if (inviteError || inviteNotice) reset()
      setInviteEmail(email)
    },
    onSubmit(email: string) {
      change({ kind: "invite", email })
    },
  }
  function changeInviteOpen(open: boolean) {
    if (pending) return
    reset()
    setInviteOpen(open)
    if (!open) setInviteEmail("")
  }

  return (
    <section
      className="family-invitations-layout"
      aria-labelledby="family-invitations"
    >
      <div className="family-invitations-list">
        <div className="family-section-label">
          <h3 id="family-invitations">Invitations</h3>
          <span>{invitations.length} pending</span>
        </div>
        {invitations.length ? (
          <ul>
            {invitations.map((invite) => (
              <li className="family-person" key={invite.id}>
                <div className="family-person-name">
                  <strong>{invite.email}</strong>
                  <span>{invitationStatus(invite)}</span>
                </div>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    change({
                      kind: "resend",
                      id: invite.id,
                      email: invite.email,
                    })
                  }
                >
                  Resend
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Manage invitation for ${invite.email}`}
                        disabled={pending}
                      />
                    }
                  >
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    mobileTitle="Invitation actions"
                  >
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        onClick={() =>
                          change({ kind: "cancel", id: invite.id })
                        }
                      >
                        Cancel invitation
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        ) : (
          <p className="family-empty">No pending invitations.</p>
        )}
      </div>
      {mobile ? (
        <Sheet
          open={inviteOpen}
          onOpenChange={changeInviteOpen}
          dismissible={!pending}
        >
          <SheetTrigger
            render={<Button variant="outline" disabled={pending} />}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            Invite someone
          </SheetTrigger>
          <SheetContent
            className="family-invite-sheet"
            showCloseButton={!pending}
          >
            <header>
              <SheetTitle>
                {inviteNotice ? "Invitation sent" : "Invite someone"}
              </SheetTitle>
              <SheetDescription className="sr-only">
                Invite a family member by email.
              </SheetDescription>
            </header>
            {inviteNotice ? (
              <>
                <p role="status">{inviteNotice}</p>
                <div className="family-invite-footer">
                  <Button onClick={() => changeInviteOpen(false)}>Done</Button>
                </div>
              </>
            ) : (
              <InviteForm
                {...inviteForm}
                onCancel={() => changeInviteOpen(false)}
              />
            )}
          </SheetContent>
        </Sheet>
      ) : (
        <div className="family-invite-inline">
          <h3>Invite someone</h3>
          <InviteForm {...inviteForm} />
          <div role="status" className="family-notice">
            {inviteNotice && (
              <>
                <Check aria-hidden="true" />
                {inviteNotice}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

function invitationStatus(invite: { delivery: string; status: string }) {
  if (invite.delivery === "failed")
    return "Email not delivered · resend to try again"
  return invite.status === "expired"
    ? "Expired · resend to renew"
    : "Waiting to join"
}

function InviteForm({
  email,
  pending,
  sending,
  error,
  onEmailChange,
  onSubmit,
  onCancel,
}: {
  email: string
  pending: boolean
  sending: boolean
  error: string
  onEmailChange: (email: string) => void
  onSubmit: (email: string) => void
  onCancel?: () => void
}) {
  const id = useId()
  const address = email.trim()
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (address && !pending) onSubmit(address)
      }}
    >
      <FieldGroup className="gap-3">
        <Field>
          <FieldLabel htmlFor={id}>Email address</FieldLabel>
          <Input
            id={id}
            type="email"
            autoComplete="email"
            placeholder="name@example.com"
            value={email}
            required
            maxLength={254}
            readOnly={pending}
            aria-describedby={error ? `${id}-hint ${id}-error` : `${id}-hint`}
            onChange={(event) => onEmailChange(event.target.value)}
          />
          <FieldDescription id={`${id}-hint`}>
            The invitation expires in 7 days.
          </FieldDescription>
          <FieldError id={`${id}-error`}>{error}</FieldError>
        </Field>
        <div className="family-invite-footer">
          {onCancel && (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onCancel}
            >
              Cancel
            </Button>
          )}
          <Button type="submit" disabled={pending || !address}>
            {sending ? "Sending…" : "Send invitation"}
          </Button>
        </div>
      </FieldGroup>
    </form>
  )
}
