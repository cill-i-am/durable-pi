import { ArrowUpRight } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { answerExamples } from "./examples"
import { RichResult } from "./rich-result"

export function AnswerGallery({
  onPrompt,
}: {
  onPrompt: (prompt: string) => void
}) {
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
      {answerExamples.map((example) => (
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
              <p className="text-lg font-medium">{example.question}</p>
            </div>
            <Button onClick={() => onPrompt(example.prompt)}>
              Use this prompt
              <ArrowUpRight data-icon="inline-end" />
            </Button>
          </div>
          <RichResult output={example.output} onPrompt={onPrompt} />
        </TabsContent>
      ))}
    </Tabs>
  )
}
