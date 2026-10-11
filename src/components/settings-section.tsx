import type { ReactNode } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"

/** The same feature operation can live in Settings or its standalone sheet. */
export function SettingsSection({
  embedded = false,
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  embedded?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  children: ReactNode
}) {
  if (embedded)
    return (
      <section hidden={!open} className="settings-section" aria-label={title}>
        <header className="settings-section-heading">
          <h2>{title}</h2>
          <p>{description}</p>
        </header>
        {children}
      </section>
    )
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  )
}
