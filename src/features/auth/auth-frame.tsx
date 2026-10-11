import { Check, LockKeyhole } from "lucide-react"
import { AgentMark } from "@/components/agent-mark"
import { Separator } from "@/components/ui/separator"

export function PiMark() {
  return <AgentMark className="pi-mark" />
}

export function AuthFrame({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <main className="login-page">
      <aside className="login-intro" aria-label="About Pi">
        <div className="login-brand">
          <PiMark />
          <span>Pi</span>
        </div>
        <div className="login-story">
          <AgentMark className="login-character" />
          <p className="login-display">
            Pick up where
            <br />
            you left off.
          </p>
          <p className="login-description">
            Your agents, their tools, and the work you’re doing together. All in
            one private place.
          </p>
          <figure className="login-preview">
            <figcaption>Example workspace</figcaption>
            {(
              [
                ["Atlas", "Your weekend guide is ready", "primary"],
                ["Research", "4 sources, one clear answer", "peach"],
                ["Studio", "Ready when you are", "lilac"],
              ] as const
            ).map(([name, detail, tone]) => (
              <div className="login-preview-row" key={name}>
                <AgentMark tone={tone} />
                <div>
                  <strong>{name}</strong>
                  <span>{detail}</span>
                </div>
                <Check aria-hidden="true" />
              </div>
            ))}
          </figure>
        </div>
        <p className="login-privacy">
          <LockKeyhole aria-hidden="true" />
          Private by default. Yours to direct.
        </p>
      </aside>
      <div className="login-content">
        <section className="login-panel" aria-labelledby="auth-title">
          <header className="login-heading">
            <h1 id="auth-title">{title}</h1>
            <p>{description}</p>
          </header>
          {children}
          <Separator />
          <p className="login-footer">
            Your workspace login is separate from your ChatGPT connection.
          </p>
        </section>
      </div>
    </main>
  )
}
