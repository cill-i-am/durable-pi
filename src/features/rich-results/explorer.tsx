import { Sparkles } from "lucide-react"
import { lazy, Suspense, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"

const AnswerGallery = lazy(() =>
  import("./gallery").then((module) => ({ default: module.AnswerGallery }))
)

export function AnswerExplorer({
  onPrompt,
  disabled = false,
}: {
  onPrompt: (prompt: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button variant="ghost" size="sm" disabled={disabled} />}
      >
        <Sparkles data-icon="inline-start" />
        Explore answers
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Answers you can explore</DialogTitle>
          <DialogDescription>
            Try a sample, then ask Pi to work with your question.
          </DialogDescription>
        </DialogHeader>
        <Suspense
          fallback={
            <Skeleton
              className="h-72 w-full"
              aria-label="Loading answer gallery"
            />
          }
        >
          <AnswerGallery
            onPrompt={(prompt) => {
              setOpen(false)
              onPrompt(prompt)
            }}
          />
        </Suspense>
      </DialogContent>
    </Dialog>
  )
}
