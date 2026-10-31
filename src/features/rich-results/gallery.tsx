import { Button } from "@workspace/ui/components/button"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@workspace/ui/components/toggle-group"
import { ArrowUpRight } from "lucide-react"
import { useState } from "react"

import { answerExamples, weatherExamples } from "./examples"
import { RichResult } from "./rich-result"

export function AnswerGallery({
  onPrompt,
}: {
  onPrompt: (prompt: string) => void
}) {
  const [weatherRange, setWeatherRange] = useState(["weekend"])
  return (
    <Tabs defaultValue="shopping" className="answer-gallery min-w-0">
      <div className="answer-categories">
        <TabsList aria-label="Answer formats">
          {answerExamples.map((example) => (
            <TabsTrigger key={example.id} value={example.id}>
              {example.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {answerExamples.map((example) => {
        const active =
          example.id === "weather"
            ? weatherExamples.find((item) => item.id === weatherRange[0])!
            : example
        return (
          <TabsContent
            key={example.id}
            value={example.id}
            className="flex min-w-0 flex-col gap-4"
          >
            <div className="answer-sample-header">
              <p className="text-base font-medium">{active.question}</p>
              <Button variant="outline" onClick={() => onPrompt(active.prompt)}>
                Use this prompt
                <ArrowUpRight data-icon="inline-end" />
              </Button>
            </div>
            {example.id === "weather" && (
              <ToggleGroup
                value={weatherRange}
                onValueChange={(value) =>
                  value.length && setWeatherRange(value)
                }
                aria-label="Forecast range"
              >
                {weatherExamples.map((item) => (
                  <ToggleGroupItem key={item.id} value={item.id}>
                    {item.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            )}
            <RichResult output={active.output} onPrompt={onPrompt} />
          </TabsContent>
        )
      })}
    </Tabs>
  )
}
