import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { Volume2, VolumeX } from "lucide-react"

import { useInteractionSoundPreference } from "@/hooks/interaction-sound-preference"

export function InteractionSoundToggle() {
  const { enabled, setEnabled } = useInteractionSoundPreference()
  const label = enabled
    ? "Mute interaction sounds"
    : "Enable interaction sounds"
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={label}
            onClick={() => setEnabled(!enabled)}
          />
        }
      >
        {enabled ? <Volume2 /> : <VolumeX />}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
