import { Button } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { Sparkles, X } from "lucide-react"
import { lazy, Suspense, useState } from "react"

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

import "./rich-results.css"

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
      <DialogContent className="answer-explorer" showCloseButton={false}>
        <DialogHeader className="answer-explorer-header">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <DialogTitle>Answers you can explore</DialogTitle>
            <DialogClose
              render={
                <Button variant="ghost" size="icon" className="shrink-0" />
              }
              aria-label="Close dialog"
            >
              <X aria-hidden="true" />
            </DialogClose>
          </div>
          <DialogDescription>
            Illustrative data. Add a sample prompt to your draft.
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
