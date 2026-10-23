import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { ArrowUpRight, MessageCircleQuestion } from "lucide-react"
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"
import type { SnapshotFrom } from "xstate"

import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { AnswerProps } from "@/rich-results/catalog"

import { ResultCard } from "./cards"
import { questionMachine } from "./question.machine"

type QuestionMachine = ReturnType<typeof questionMachine>

export const AnswerDraftContext = createContext<
  ((text: string) => void) | undefined
>(undefined)

export function QuestionCard(props: AnswerProps<"Question">) {
  const onPrompt = useContext(AnswerDraftContext)
  const [chosen, setChosen] = useState<string[]>([])
  const [other, setOther] = useState("")
  const revision = useRef(0)
  const append = useRef(onPrompt)
  const [actor, setActor] = useState<EffectActor<QuestionMachine> | null>(null)
  const [snapshot, setSnapshot] =
    useState<SnapshotFrom<QuestionMachine> | null>(null)
  useEffect(() => {
    append.current = onPrompt
  }, [onPrompt])
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owned = yield* createEffectActor(
          questionMachine((answer) =>
            Effect.try({
              try: () => {
                if (!append.current) throw new Error("Draft is unavailable")
                append.current(answer.text)
              },
              catch: (cause) => cause,
            })
          ),
          { input: { revision: 0, enabled: !!append.current } }
        )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owned.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) {
          setActor(owned)
          setSnapshot(owned.getSnapshot())
        }
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      Effect.runFork(
        Fiber.interrupt(fiber).pipe(
          Effect.andThen(Fiber.await(fiber)),
          Effect.flatMap((exit) =>
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? Effect.logError(exit.cause)
              : Effect.void
          )
        )
      )
    }
  }, [])
  useEffect(() => {
    if (actor)
      Effect.runFork(
        send(actor, {
          type: "VIEW",
          revision: revision.current,
          enabled: !!onPrompt,
        })
      )
  }, [actor, onPrompt])
  const edited = () => {
    revision.current++
    if (actor)
      Effect.runFork(
        send(actor, {
          type: "VIEW",
          revision: revision.current,
          enabled: !!onPrompt,
        })
      )
  }
  const added = snapshot?.matches("added") === true
  const busy = !actor || snapshot?.matches("adding") === true
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
            disabled={
              busy || added || !onPrompt || (!chosen.length && !other.trim())
            }
            onClick={() => {
              if (actor)
                Effect.runFork(
                  send(actor, {
                    type: "ADD",
                    revision: revision.current,
                    text: `For “${props.question}”: ${[...chosen, other.trim()].filter(Boolean).join("; ")}`,
                  })
                )
            }}
          >
            Add answer to draft <ArrowUpRight data-icon="inline-end" />
          </Button>
          <p role="status" className="text-xs text-muted-foreground">
            {snapshot?.context.failure
              ? "Couldn’t add your answer. Your choices are still here; try again."
              : added
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
            edited()
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
                edited()
              }}
            />
          </Field>
        </FieldGroup>
      </div>
    </ResultCard>
  )
}
