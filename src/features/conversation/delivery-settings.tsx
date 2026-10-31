import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@workspace/ui/components/field"
import { useId } from "react"

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
    <div className="settings-preference settings-delivery-preference">
      <Field>
        <FieldLabel htmlFor={id}>During a reply</FieldLabel>
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
