import { useState, type ComponentProps } from "react"
import { Eye, EyeOff } from "lucide-react"
import { useInteractionSound } from "@/hooks/use-interaction-sound"
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
} from "@/components/ui/input-group"

export function PasswordInput(
  props: Omit<ComponentProps<typeof InputGroupInput>, "type">
) {
  const [visible, setVisible] = useState(false)
  const playInteractionSound = useInteractionSound()
  return (
    <InputGroup>
      <InputGroupInput {...props} type={visible ? "text" : "password"} />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          type="button"
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
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}
