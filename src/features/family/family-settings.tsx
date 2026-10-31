import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Effect, Fiber } from "effect"
import {
  ArrowUpRight,
  Check,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  Users,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
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
} from "@/components/ui/sheet"
import type { FamilyMember } from "@/family/contracts"

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
  const [inviteOpen, setInviteOpen] = useState(false)
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
  const { pending, error, notice, sent, removed } = changeView(
    snapshot,
    removing
  )
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
  const owner = family.role === "owner"
  return (
    <section className="settings-section family-settings" aria-label="Family">
      <header className="settings-section-heading family-heading">
        <div>
          <h2>Family</h2>
          <p>One family. A private space for each person.</p>
        </div>
        {owner && (
          <Button
            onClick={() => {
              reset()
              setInviteOpen(true)
            }}
            disabled={pending}
          >
            <Plus />
            Invite someone
          </Button>
        )}
      </header>
      <div className="settings-section-body">
        {error && (
          <Alert role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div role="status" className="family-notice">
          {notice && (
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
          <ul className="family-roster">
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
          <section aria-labelledby="family-invitations">
            <div className="family-section-label">
              <h3 id="family-invitations">Invitations</h3>
              <span>{family.invitations.length} pending</span>
            </div>
            {family.invitations.length ? (
              <ul className="family-roster">
                {family.invitations.map((invite) => (
                  <li
                    className="family-person family-invitation"
                    key={invite.id}
                  >
                    <span className="family-avatar" aria-hidden="true">
                      <Users />
                    </span>
                    <div className="family-person-name">
                      <strong>{invite.email}</strong>
                      <span>{invitationStatus(invite)}</span>
                    </div>
                    <Button
                      variant="ghost"
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
              <p className="family-empty">
                No pending invitations. Invite someone when you’re ready.
              </p>
            )}
          </section>
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
      {inviteOpen && (
        <InviteSheet
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          familyName={family.name}
          pending={pending}
          onInvite={(email) => change({ kind: "invite", email })}
          sent={sent}
          error={error}
        />
      )}
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
  const sent = !!notice && command?.kind === "invite"
  const removed =
    !!notice && command?.kind === "remove" && command.id === removing?.id
  return { pending, error, notice, sent, removed }
}

function invitationStatus(invite: { delivery: string; status: string }) {
  if (invite.delivery === "failed")
    return "Email not delivered · resend to try again"
  return invite.status === "expired"
    ? "Expired · resend to renew"
    : "Waiting to join"
}

function InviteSheet({
  open,
  onOpenChange,
  familyName,
  pending,
  onInvite,
  sent,
  error,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  familyName: string
  pending: boolean
  onInvite: (email: string) => void
  sent: boolean
  error: string
}) {
  const [email, setEmail] = useState("")
  return (
    <Sheet
      open={open}
      dismissible={!pending}
      onOpenChange={(value) => {
        if (!pending) {
          onOpenChange(value)
          if (!value) {
            setEmail("")
          }
        }
      }}
    >
      <SheetContent className="family-invite-sheet" mobileLayout="panel">
        <header>
          <SheetTitle>{sent ? "Invitation sent" : "Invite someone"}</SheetTitle>
          <SheetDescription>
            {sent
              ? `${email} can now join ${familyName}.`
              : `Give someone their own private space in ${familyName}.`}
          </SheetDescription>
        </header>
        {sent ? (
          <>
            <div className="family-sent">
              <Check />
              <h2>They’re on the list.</h2>
              <p>
                We’ve sent an email with a link to join. You can resend or
                cancel it from Family settings.
              </p>
            </div>
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              onInvite(email.trim())
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="family-invite-email">
                  Email address
                </FieldLabel>
                <Input
                  id="family-invite-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  required
                  maxLength={254}
                  disabled={pending}
                  onChange={(event) => setEmail(event.target.value)}
                />
                <FieldDescription>
                  The invitation expires in 7 days.
                </FieldDescription>
              </Field>
              <div className="family-privacy">
                <LockKeyhole />
                <div>
                  <h3>A private workspace</h3>
                  <p>
                    They’ll have their own chats, agents, memory, files and
                    connected accounts, with access to the family’s ChatGPT
                    connection.
                  </p>
                </div>
              </div>
              {error && (
                <Alert role="alert">
                  <AlertDescription>
                    {error} If delivery failed, the invitation remains in Family
                    settings. Use Resend to try again.
                  </AlertDescription>
                </Alert>
              )}
              <div className="family-invite-footer">
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={pending || !email.trim()}>
                  {pending ? "Sending…" : "Send invitation"}
                </Button>
              </div>
            </FieldGroup>
          </form>
        )}
      </SheetContent>
    </Sheet>
  )
}
