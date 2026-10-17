import { Maximize2 } from "lucide-react"
import { useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

// View state belongs to the card above this shell, so expanding never clears its filters or shortlist.
export function AnswerWorkspace({
  title,
  description,
  sidebar,
  children,
}: {
  title: string
  description: string
  sidebar?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger
          render={<Button variant="outline" size="sm" className="self-end" />}
        >
          <Maximize2 data-icon="inline-start" /> Open workspace
        </DialogTrigger>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[min(90rem,calc(100vw-3rem))]">
          <DialogHeader className="pr-8">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {open && (
            <div
              className={
                sidebar
                  ? "grid min-w-0 gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]"
                  : "min-w-0"
              }
            >
              {sidebar && (
                <aside className="flex min-w-0 flex-col gap-5 rounded-lg bg-muted/40 p-5">
                  {sidebar}
                </aside>
              )}
              <div className="@container min-w-0">{children}</div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {!open && children}
    </div>
  )
}
