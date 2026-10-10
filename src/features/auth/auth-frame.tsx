import { LockKeyhole } from "lucide-react"

export function PiMark() {
  return (
    <span className="pi-mark" aria-label="Pi">
      π
    </span>
  )
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
      <div className="login-brand">
        <PiMark />
        <span>Pi</span>
        <span className="login-caption">A little more continuity.</span>
      </div>
      <section className="login-panel">
        <LockKeyhole className="login-lock" aria-hidden="true" />
        <h1>{title}</h1>
        <p className="text-muted-foreground">{description}</p>
        {children}
      </section>
      <footer className="login-footer">
        Private by default. Your conversation stays yours.
      </footer>
    </main>
  )
}
