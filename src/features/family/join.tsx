import { Effect, Fiber, Redacted, Schema } from "effect"
import { Check, LockKeyhole } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { authClient } from "@/auth/client"
import { AgentMark } from "@/components/agent-mark"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InvitationPreview } from "@/family/contracts"
import { AuthFrame } from "@/features/auth/auth-frame"
import { PasskeySignIn } from "@/features/auth/passkey-sign-in"
import { api, ApiError } from "@/http/client"

import { makeFamilyJoin } from "./family-join-owner"
import {
  familyJoinMachine,
  type JoinCommand,
  type JoinInvitation,
} from "./family-join.machine"
import { invitationRecord } from "./invitation-record"

type Invitation = JoinInvitation
type Session = NonNullable<ReturnType<typeof authClient.useSession>["data"]>
type Step =
  | "loading"
  | "unavailable"
  | "error"
  | "wrong-account"
  | "verify"
  | "accept"
  | "account"
  | "welcome"

class InvitationUnavailable extends Error {}

function joinStep(
  loading: boolean,
  welcome: boolean,
  invitation: Invitation | null,
  session: Session | null,
  loadFailed: boolean
): Step {
  if (welcome) return "welcome"
  if (loading) return "loading"
  if (loadFailed) return "error"
  if (!invitation || invitation.status !== "pending") return "unavailable"
  if (!session) return "account"
  if (session.user.email.toLowerCase() !== invitation.email.toLowerCase())
    return "wrong-account"
  return session.user.emailVerified ? "accept" : "verify"
}
function useJoinFlow() {
  const { data: session, isPending, refetch } = authClient.useSession()
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const latest = useRef({ session, refetch })
  latest.current = { session, refetch }
  const owner = useRef<Effect.Success<
    ReturnType<typeof makeFamilyJoin>
  > | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<
    ReturnType<typeof familyJoinMachine>
  > | null>(null)
  useEffect(() => {
    let mounted = true
    // Accessing sessionStorage itself can fail in a privacy-restricted tab.
    const storage = {
      getItem: (key: string) => window.sessionStorage.getItem(key),
      setItem: (key: string, value: string) =>
        window.sessionStorage.setItem(key, value),
      removeItem: (key: string) => window.sessionStorage.removeItem(key),
    }
    const record = invitationRecord(storage)
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const value = yield* makeFamilyJoin({
          verify: async (token, signal) => {
            await api("/api/family/verify", { token }, signal)
          },
          locate: async (signal) => {
            const result = await authClient.organization.listUserInvitations()
            signal.throwIfAborted()
            if (result.error) {
              if ([401, 403].includes(result.error.status))
                throw new InvitationUnavailable()
              throw new Error("Could not check invitations.")
            }
            const id = result.data?.find(
              (item) =>
                item.organizationId === "family" &&
                item.status === "pending" &&
                new Date(item.expiresAt).getTime() > Date.now()
            )?.id
            if (!id) throw new InvitationUnavailable()
            record.remember(id)
            return id
          },
          preview: async (id, signal) => ({
            ...Schema.decodeUnknownSync(InvitationPreview)(
              await api(
                "/api/family/invitation",
                { invitation: id },
                AbortSignal.any([signal, AbortSignal.timeout(10_000)])
              )
            ),
            id,
          }),
          session: () => {
            const data = latest.current.session
            return data
              ? { email: data.user.email, verified: data.user.emailVerified }
              : null
          },
          refresh: () => latest.current.refetch(),
          change: async (invitation, command) => {
            const result =
              command.kind === "signin"
                ? await authClient.signIn.email({
                    email: invitation.email,
                    password: Redacted.value(command.password),
                  })
                : command.kind === "signup"
                  ? await authClient.signUp.email(
                      {
                        email: invitation.email,
                        password: Redacted.value(command.password),
                        name: command.name,
                      },
                      { headers: { "x-family-invitation": invitation.id } }
                    )
                  : command.kind === "accept"
                    ? await authClient.organization.acceptInvitation({
                        invitationId: invitation.id,
                      })
                    : command.kind === "resend"
                      ? await authClient.sendVerificationEmail(
                          { email: invitation.email },
                          { headers: { "x-family-invitation": invitation.id } }
                        )
                      : await authClient.signOut()
            if (result.error)
              throw new Error(
                result.error.message || "Could not continue. Please try again."
              )
          },
          joined: (id) => {
            record.joined(id)
            window.history.replaceState(null, "", "/join")
          },
          classify: (cause) => ({
            unavailable:
              cause instanceof InvitationUnavailable ||
              (cause instanceof ApiError &&
                [400, 404, 410].includes(cause.status)),
            temporary:
              cause instanceof TypeError ||
              (cause instanceof DOMException &&
                cause.name === "TimeoutError") ||
              (cause instanceof ApiError && cause.status >= 500),
          }),
        })
        if (!mounted) {
          value.revoke()
          return
        }
        owner.current = value
        const subscription = value.actor.subscribe((state) => {
          if (mounted) setSnapshot(state)
        })
        function open() {
          const hash = new URLSearchParams(window.location.hash.slice(1))
          const token = hash.get("token")
          const id = hash.get("invitation") || record.restore()
          if (id) {
            hash.set("invitation", id)
            record.remember(id)
          }
          hash.delete("token")
          window.history.replaceState(
            null,
            "",
            `/join${hash.size ? `#${hash}` : ""}`
          )
          setPassword("")
          value.open(id, token)
        }
        open()
        window.addEventListener("hashchange", open)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            window.removeEventListener("hashchange", open)
            subscription.unsubscribe()
          })
        )
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      owner.current?.revoke()
      owner.current = null
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [])
  const generation = snapshot?.context.source.generation ?? 0
  useEffect(() => {
    owner.current?.actor.send({
      type: "SESSION",
      pending: isPending,
      session: session
        ? { email: session.user.email, verified: session.user.emailVerified }
        : null,
    })
  }, [session, isPending, generation])
  const { invitation, pending, loading, signin, error, notice } =
    joinView(snapshot)
  function dispatchCommand(command: JoinCommand) {
    owner.current?.actor.send({ type: "COMMAND", command })
  }
  function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const secret = Redacted.make(password)
    setPassword("")
    dispatchCommand(
      signin
        ? { kind: "signin", password: secret }
        : { kind: "signup", password: secret, name: name.trim() }
    )
  }
  return {
    session,
    invitation,
    error,
    pending,
    signin,
    name,
    password,
    notice,
    setName,
    setPassword,
    setPending: (busy: boolean) =>
      owner.current?.actor.send({ type: "EXTERNAL", generation, busy }),
    refetch: () => owner.current?.refresh(generation) ?? Promise.resolve(),
    submit,
    join: () => dispatchCommand({ kind: "accept" }),
    resend: () => dispatchCommand({ kind: "resend" }),
    switchAccount: () => dispatchCommand({ kind: "switch" }),
    toggleSignin: () => {
      setPassword("")
      owner.current?.actor.send({ type: "TOGGLE" })
    },
    retry: () => owner.current?.actor.send({ type: "RETRY" }),
    step: joinStep(
      loading || isPending,
      !!snapshot?.matches("welcome"),
      invitation,
      session,
      !!snapshot?.matches("failed")
    ),
  }
}
function joinView(
  snapshot: SnapshotFrom<ReturnType<typeof familyJoinMachine>> | null
) {
  const invitation = snapshot?.context.invitation ?? null
  const pending =
    !!snapshot &&
    (snapshot.matches({ working: "change" }) ||
      snapshot.matches({ working: "changedSession" }) ||
      snapshot.matches({ working: "joined" }) ||
      snapshot.matches("external"))
  const loading =
    !snapshot ||
    snapshot.matches("empty") ||
    snapshot.context.queued !== null ||
    (snapshot.matches("working") && !pending)
  const signin = snapshot?.context.signin ?? false
  const error = snapshot?.context.error ?? ""
  const notice = snapshot?.context.notice ?? ""
  return { invitation, pending, loading, signin, error, notice }
}
function joinTitle(step: Step, familyName: string, signin: boolean) {
  switch (step) {
    case "loading":
      return "Opening your invitation"
    case "welcome":
      return "Your space is ready"
    case "unavailable":
      return "This invitation is unavailable"
    case "error":
      return "Couldn’t load your invitation"
    case "verify":
      return "Check your email"
    case "account":
      return signin ? "Sign in to join" : `Join ${familyName}`
    default:
      return `Join ${familyName}`
  }
}
export function JoinFamily() {
  const flow = useJoinFlow()
  const description =
    flow.step === "welcome"
      ? "A fresh start, with your own personal assistant."
      : flow.invitation
        ? `${flow.invitation.inviterName} invited you to a private workspace on Pi.`
        : "Your own space, with access to your family’s ChatGPT connection."
  return (
    <AuthFrame
      family
      title={joinTitle(
        flow.step,
        flow.invitation?.familyName ?? "your family",
        flow.signin
      )}
      description={description}
    >
      {flow.notice && (
        <p role="status" className="family-notice">
          <Check />
          {flow.notice}
        </p>
      )}
      {flow.error && (
        <Alert role="alert">
          <AlertDescription>{flow.error}</AlertDescription>
        </Alert>
      )}
      <JoinContent flow={flow} />
    </AuthFrame>
  )
}
function JoinContent({ flow }: { flow: ReturnType<typeof useJoinFlow> }) {
  const { invitation, session, pending } = flow
  switch (flow.step) {
    case "loading":
      return <p role="status">Just a moment…</p>
    case "error":
      return <Button onClick={flow.retry}>Try again</Button>
    case "welcome":
      return <Welcome />
    case "unavailable":
      return (
        <>
          <p className="settings-description">
            Ask your family admin for a new invitation.
          </p>
          <Button
            variant="outline"
            render={<a href="/" aria-label="Back to sign in" />}
          >
            Back to sign in
          </Button>
        </>
      )
    case "wrong-account":
      return (
        <>
          <p>
            You’re signed in as <strong>{session?.user.email}</strong>. This
            invitation is for <strong>{invitation?.email}</strong>.
          </p>
          <Button disabled={pending} onClick={() => void flow.switchAccount()}>
            Switch account
          </Button>
        </>
      )
    case "verify":
      return (
        <>
          <p>
            We sent a verification link to <strong>{invitation?.email}</strong>.
            Open it to finish joining.
          </p>
          <p className="settings-description">
            The link expires in one hour. Check your spam folder if it hasn’t
            arrived.
          </p>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => void flow.resend()}
          >
            Resend verification email
          </Button>
        </>
      )
    case "accept":
      return (
        <>
          <div className="family-invited-email">
            Joining as<strong>{invitation?.email}</strong>
          </div>
          <PrivateWork />
          <Button size="lg" disabled={pending} onClick={() => void flow.join()}>
            {pending ? "Joining…" : "Join family"}
          </Button>
        </>
      )
    case "account":
      return <JoinAccount flow={flow} />
  }
}
function JoinAccount({ flow }: { flow: ReturnType<typeof useJoinFlow> }) {
  const { invitation, signin, name, password, pending } = flow
  return (
    <>
      <div className="family-invited-email">
        Invited email<strong>{invitation?.email}</strong>
      </div>
      <form onSubmit={flow.submit}>
        <FieldGroup>
          {!signin && (
            <Field>
              <FieldLabel htmlFor="join-name">Your name</FieldLabel>
              <Input
                id="join-name"
                autoComplete="name"
                required
                maxLength={80}
                value={name}
                disabled={pending}
                onChange={(event) => flow.setName(event.target.value)}
              />
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="join-password">
              {signin ? "Password" : "Create a password"}
            </FieldLabel>
            <Input
              id="join-password"
              type="password"
              autoComplete={signin ? "current-password" : "new-password"}
              required
              minLength={signin ? undefined : 12}
              maxLength={128}
              value={password}
              disabled={pending}
              onChange={(event) => flow.setPassword(event.target.value)}
            />
            {!signin && (
              <FieldDescription>At least 12 characters.</FieldDescription>
            )}
          </Field>
          <Button type="submit" size="lg" disabled={pending}>
            {pending ? "Continuing…" : signin ? "Sign in" : "Create account"}
          </Button>
        </FieldGroup>
      </form>
      {signin && (
        <PasskeySignIn
          key={invitation?.id}
          disabled={pending}
          onBusyChange={flow.setPending}
          onSignedIn={flow.refetch}
        />
      )}
      {signin && (
        <a
          className="text-sm text-primary underline underline-offset-4"
          href="/forgot-password"
        >
          Forgot password?
        </a>
      )}
      <p className="family-auth-switch">
        {signin ? "New to Pi?" : "Already have an account?"}
        <Button variant="link" disabled={pending} onClick={flow.toggleSignin}>
          {signin ? "Create an account" : "Sign in"}
        </Button>
      </p>
    </>
  )
}
function PrivateWork() {
  return (
    <div className="family-privacy">
      <LockKeyhole />
      <p>
        Your work stays private. Your family admin manages access, and can’t
        open your chats or files.
      </p>
    </div>
  )
}
function Welcome() {
  return (
    <>
      <div className="family-welcome">
        <AgentMark />
        <h2>Your personal assistant</h2>
        <p>Ready to help with whatever’s on your mind.</p>
      </div>
      <PrivateWork />
      <Button size="lg" onClick={() => window.location.assign("/agents/home")}>
        Open my workspace
      </Button>
    </>
  )
}
