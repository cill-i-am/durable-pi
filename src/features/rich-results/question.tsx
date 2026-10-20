import { ArrowUpRight, MessageCircleQuestion } from "lucide-react"
import { createContext, useContext, useId, useState } from "react"

import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { AnswerProps } from "@/rich-results/catalog"

import { ResultCard } from "./cards"

export const AnswerDraftContext = createContext<
  ((text: string) => void) | undefined
>(undefined)

export function QuestionCard(props: AnswerProps<"Question">) {
  const onPrompt = useContext(AnswerDraftContext)
  const [chosen, setChosen] = useState<string[]>([])
  const [other, setOther] = useState("")
  const [added, setAdded] = useState(false)
  const id = useId()
  return (
    <ResultCard
      title={props.question}
      description={props.description}
      action={
        <MessageCircleQuestion
          aria-hidden="true"
          className="size-5 text-primary"
        />
      }
      panel={
        <div className="flex w-full flex-wrap items-center gap-3">
          <Button
            disabled={added || !onPrompt || (!chosen.length && !other.trim())}
            onClick={() => {
              onPrompt?.(
                `For “${props.question}”: ${[...chosen, other.trim()].filter(Boolean).join("; ")}`
              )
              setAdded(true)
            }}
          >
            Add answer to draft <ArrowUpRight data-icon="inline-end" />
          </Button>
          <p role="status" className="text-xs text-muted-foreground">
            {added
              ? "Added to your draft. Review it before sending."
              : onPrompt
                ? "You can review your answer before sending."
                : "Reply in the conversation with your answer."}
          </p>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <ToggleGroup
          multiple={props.multiple}
          value={chosen}
          onValueChange={(value) => {
            setChosen(value)
            setAdded(false)
          }}
          aria-label={props.question}
          variant="outline"
          className="flex flex-wrap justify-start gap-2"
        >
          {props.options.map((option) => (
            <ToggleGroupItem
              key={option.label}
              value={option.label}
              className="h-auto min-h-10 flex-col items-start gap-1 py-3 text-left whitespace-normal"
            >
              <span>{option.label}</span>
              {option.description && (
                <span className="text-xs font-normal text-muted-foreground">
                  {option.description}
                </span>
              )}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={id}>Add your own answer</FieldLabel>
            <Textarea
              id={id}
              value={other}
              maxLength={2000}
              placeholder="Anything else Pi should know…"
              onChange={(event) => {
                setOther(event.target.value)
                setAdded(false)
              }}
            />
          </Field>
        </FieldGroup>
      </div>
    </ResultCard>
  )
}
