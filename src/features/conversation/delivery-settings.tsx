import { useId } from "react"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  setMessageDeliveryDefault,
  useMessageDeliveryDefault,
} from "./delivery-preference"

const items = [
  { value: "steer", label: "Steer the active reply" },
  { value: "followUp", label: "Queue a new reply" },
]

export function MessageDeliverySettings() {
  const id = useId()
  const mode = useMessageDeliveryDefault()
  return (
    <div className="settings-preference">
      <Field>
        <FieldLabel htmlFor={id}>Default message delivery</FieldLabel>
        <FieldDescription id={`${id}-description`}>
          Choose what a message does during a reply. You can change this in the
          composer.
        </FieldDescription>
        <Select
          items={items}
          value={mode}
          onValueChange={(value) => {
            if (value === "steer" || value === "followUp")
              setMessageDeliveryDefault(value)
          }}
        >
          <SelectTrigger id={id} aria-describedby={`${id}-description`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    </div>
  )
}
