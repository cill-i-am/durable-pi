import { Schema } from "effect"
import { Check, LockKeyhole } from "lucide-react"
import { useEffect, useState } from "react"

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
import { api } from "@/http/client"

type Invitation = InvitationPreview & { id: string }
type Session = NonNullable<ReturnType<typeof authClient.useSession>["data"]>
type Step =
  | "loading"
  | "unavailable"
  | "wrong-account"
  | "verify"
  | "accept"
  | "account"
  | "welcome"

async function openInvitation(refetch: () => Promise<unknown>) {
  const hash = new URLSearchParams(window.location.hash.slice(1))
  const token = hash.get("token")
  let verificationFailed = false
  let id = hash.get("invitation")
  if (token) {
    hash.delete("token")
    window.history.replaceState(null, "", `/join${hash.size ? `#${hash}` : ""}`)
    try {
      await api("/api/family/verify", { token })
    } catch {
      verificationFailed = true
    }
    await refetch()
  }
  if (!id) {
    const result = await authClient.organization.listUserInvitations()
    if (result.error) throw new Error("Open the invitation from your email.")
    id =
      result.data?.find(
        (item) =>
          item.organizationId === "family" &&
          item.status === "pending" &&
          new Date(item.expiresAt).getTime() > Date.now()
      )?.id ?? null
  }
  if (!id) throw new Error("Open the invitation from your email.")
  const preview = Schema.decodeUnknownSync(InvitationPreview)(
    await api("/api/family/invitation", { invitation: id })
  )
  return {
    invitation: { ...preview, id },
    verified: !!token && !verificationFailed,
    verificationFailed,
    needsSignin: !!token,
  }
}
function joinStep(
  loading: boolean,
  welcome: boolean,
  invitation: Invitation | null,
  session: Session | null
): Step {
  if (welcome) return "welcome"
  if (loading) return "loading"
  if (!invitation || invitation.status !== "pending") return "unavailable"
  if (!session) return "account"
  if (session.user.email.toLowerCase() !== invitation.email.toLowerCase())
    return "wrong-account"
  return session.user.emailVerified ? "accept" : "verify"
}
function useJoinFlow() {
  const { data: session, isPending, refetch } = authClient.useSession()
  const [invitation, setInvitation] = useState<Invitation | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  const [welcome, setWelcome] = useState(false)
  const [signin, setSignin] = useState(false)
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [notice, setNotice] = useState("")
  useEffect(() => {
    let disposed = false
    let sequence = 0
    function load() {
      const current = ++sequence
      setLoading(true)
      void openInvitation(refetch)
        .then((result) => {
          if (disposed || current !== sequence) return
          setInvitation(result.invitation)
          setError(
            result.verificationFailed
              ? "This verification link could not be confirmed. Resend the verification email below, or sign in to request a new link."
              : ""
          )
          if (result.needsSignin) setSignin(true)
          if (result.verified)
            setNotice("Email verified. Finish joining your family below.")
        })
        .catch(() => {
          if (!disposed && current === sequence)
            setError(
              "This link could not be opened. It may have expired or been cancelled. Open the latest invitation email, or ask your family admin to resend it."
            )
        })
        .finally(() => {
          if (!disposed && current === sequence) setLoading(false)
        })
    }
    load()
    window.addEventListener("hashchange", load)
    return () => {
      disposed = true
      window.removeEventListener("hashchange", load)
    }
    // Re-open a verification link arriving in this tab, without repeating it on session refresh.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [])
  async function perform(work: () => Promise<void>) {
    if (pending) return
    setPending(true)
    setError("")
    try {
      await work()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not connect. Please try again."
      )
    } finally {
      setPending(false)
    }
  }
  const join = () =>
    perform(async () => {
      if (!invitation) return
      const result = await authClient.organization.acceptInvitation({
        invitationId: invitation.id,
      })
      if (result.error)
        throw new Error(result.error.message || "Could not join the family.")
      await refetch()
      setWelcome(true)
      window.history.replaceState(null, "", "/join")
    })
  function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    void perform(async () => {
      if (!invitation) return
      const result = signin
        ? await authClient.signIn.email({ email: invitation.email, password })
        : await authClient.signUp.email(
            { email: invitation.email, password, name: name.trim() },
            { headers: { "x-family-invitation": invitation.id } }
          )
      if (result.error)
        throw new Error(
          result.error.message || "Could not continue. Please try again."
        )
      setPassword("")
      await refetch()
    })
  }
  const resend = () =>
    perform(async () => {
      if (!invitation) return
      const result = await authClient.sendVerificationEmail(
        { email: invitation.email },
        { headers: { "x-family-invitation": invitation.id } }
      )
      if (result.error)
        throw new Error(
          result.error.message || "Could not send. Please try again."
        )
      setNotice("Verification email sent.")
    })
  const switchAccount = () =>
    perform(async () => {
      await authClient.signOut()
      await refetch()
    })
  const toggleSignin = () => {
    setSignin(!signin)
    setError("")
    setPassword("")
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
    setPending,
    refetch,
    submit,
    join,
    resend,
    switchAccount,
    toggleSignin,
    step: joinStep(loading || isPending, welcome, invitation, session),
  }
}
function joinTitle(step: Step, familyName: string, signin: boolean) {
  switch (step) {
    case "loading":
      return "Opening your invitation"
    case "welcome":
      return "Your space is ready"
    case "unavailable":
      return "This invitation is unavailable"
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
