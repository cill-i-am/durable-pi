import { AgentMark } from "@/components/agent-mark"
import { InteractionSoundToggle } from "@/components/interaction-sound-toggle"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card"
import { ThemeMenu } from "@/features/appearance/appearance-settings"

export function PiMark() {
  return <AgentMark className="pi-mark" />
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
      className="login-page"
      data-family={family || undefined}
    >
      <header className="login-header">
        <div className="login-brand">
          <PiMark /> <span>Pi</span>
        </div>
        <div className="flex items-center gap-1">
          <ThemeMenu />
          <InteractionSoundToggle />
        </div>
      </header>
      <div className="login-content">
        <Card
          className="login-panel"
          role="region"
          aria-labelledby="auth-title"
        >
          <CardHeader className="login-heading">
            <CardTitle>
              <h1 id="auth-title">{title}</h1>
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent className="login-form">{children}</CardContent>
          {(footer || family) && (
            <CardFooter className="login-footer">
              {footer ?? (
                <p className="text-sm text-muted-foreground">
                  Your chats, agents, memory, files and connected accounts are
                  private to you.
                </p>
              )}
            </CardFooter>
          )}
        </Card>
      </div>
    </main>
  )
}
