import {
  Card,
  CardHeader,
  CardDescription,
  CardContent,
  CardFooter,
} from "@workspace/ui/components/card"

import { AgentMark } from "@/components/agent-mark"
import { InteractionSoundToggle } from "@/components/interaction-sound-toggle"
import { ThemeMenu } from "@/features/appearance/appearance-settings"

import "./auth-entry.css"

export function PiMark() {
  return <AgentMark className="auth-entry-mark" />
}

export function AuthFrame({
  title,
  description,
  children,
  family = false,
  footer,
}: {
  title: string
  description: string
  children: React.ReactNode
  family?: boolean
  footer?: React.ReactNode
}) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="auth-entry-page"
      data-family={family || undefined}
    >
      <div className="auth-entry-surface">
        <header className="auth-entry-header">
          <div className="auth-entry-brand">
            <PiMark /> <span>Pi</span>
          </div>
          <div className="flex items-center gap-1">
            <ThemeMenu />
            <InteractionSoundToggle />
          </div>
        </header>
        <div className="auth-entry-content">
          <Card
            className="auth-entry-panel"
            role="region"
            aria-labelledby="auth-title"
          >
            <CardHeader className="auth-entry-heading">
              <h1 id="auth-title">{title}</h1>
              <CardDescription>{description}</CardDescription>
            </CardHeader>
            <CardContent className="auth-entry-form">{children}</CardContent>
            {footer && (
              <CardFooter className="auth-entry-footer">{footer}</CardFooter>
            )}
          </Card>
        </div>
      </div>
    </main>
  )
}
