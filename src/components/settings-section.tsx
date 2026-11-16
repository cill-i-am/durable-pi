import type { ReactNode } from "react"

export function SettingsSection({
  open,
  title,
  description,
  children,
}: {
  open: boolean
  title: string
  description: ReactNode
  children: ReactNode
}) {
  return (
    <section hidden={!open} className="settings-section" aria-label={title}>
      <header className="settings-section-heading">
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      {children}
    </section>
  )
}
