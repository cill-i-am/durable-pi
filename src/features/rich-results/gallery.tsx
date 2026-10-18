import { ArrowUpRight } from "lucide-react"
import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

import { answerExamples, weatherExamples } from "./examples"
import { RichResult } from "./rich-result"

export function AnswerGallery({
  onPrompt,
}: {
  onPrompt: (prompt: string) => void
}) {
  const [weatherRange, setWeatherRange] = useState(["weekend"])
  return (
    <Tabs defaultValue="shopping" className="min-w-0">
      <div className="overflow-x-auto pb-2">
        <TabsList>
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
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-2">
                <Badge variant="outline">
                  Interactive sample · illustrative data
                </Badge>
                <p className="text-lg font-medium">{active.question}</p>
              </div>
              <Button onClick={() => onPrompt(active.prompt)}>
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
                variant="outline"
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
