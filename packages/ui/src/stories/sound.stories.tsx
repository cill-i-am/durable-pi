import type { Meta, StoryObj } from "@storybook/react-vite"
import { Button } from "@workspace/ui/components/button"
import { useRef } from "react"

import type { SoundCue } from "./sound/sound.machine"
import { useSoundAudition } from "./sound/use-sound-audition"

const meta = {
  title: "Foundations/Sound",
  parameters: { layout: "padded" },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

function SoundAudition() {
  const sound = useSoundAudition()
  const sequence = useRef(0)
  const play = (cue: SoundCue) =>
    sound.send({
      type: "CUE",
      receipt: `audition-${++sequence.current}`,
      cue,
      outcome: "confirmed",
      meaningful: true,
      actionable: true,
      repeated: false,
    })
  return (
    <main className="flex max-w-lg flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold">Sound audition</h1>
        <p className="text-sm text-muted-foreground">
          Two short, quiet cues to try. Sound starts muted on every visit.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          static
          variant="outline"
          disabled={!sound.canEnable && sound.muted}
          onClick={() => sound.send({ type: sound.muted ? "ENABLE" : "MUTE" })}
        >
          {sound.muted ? "Enable sound" : "Mute sound"}
        </Button>
      </div>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-medium">Complete</h2>
            <p className="text-sm text-muted-foreground">
              Confirmed, meaningful completion.
            </p>
          </div>
          <Button
            static
            variant="outline"
            disabled={!sound.canPlay}
            onClick={() => play("complete")}
          >
            Play Complete
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-medium">Attention</h2>
            <p className="text-sm text-muted-foreground">
              Confirmed failure that needs action.
            </p>
          </div>
          <Button
            static
            variant="outline"
            disabled={!sound.canPlay}
            onClick={() => play("attention")}
          >
            Play Attention
          </Button>
        </div>
      </div>
      <p role="status" className="min-h-10 text-sm text-muted-foreground">
        {sound.message}
      </p>
    </main>
  )
}

export const Audition: Story = { render: () => <SoundAudition /> }
