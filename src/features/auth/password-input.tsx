import { Button } from "@workspace/ui/components/button"
import { Eye, EyeOff } from "lucide-react"
import { useState, type ComponentProps } from "react"

import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
} from "@/components/ui/input-group"
import { useInteractionSound } from "@/hooks/use-interaction-sound"

export function PasswordInput(
  props: Omit<ComponentProps<typeof InputGroupInput>, "type">
) {
  const [visible, setVisible] = useState(false)
  const playInteractionSound = useInteractionSound()
  return (
    <InputGroup>
      <InputGroupInput {...props} type={visible ? "text" : "password"} />
      <InputGroupAddon align="inline-end">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={props.disabled}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          aria-controls={props.id}
          onClick={() => {
            setVisible((value) => !value)
            void playInteractionSound()
          }}
        >
          {visible ? <EyeOff /> : <Eye />}
        </Button>
      </InputGroupAddon>
    </InputGroup>
  )
}
