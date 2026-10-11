import { Field, FieldLabel } from "@/components/ui/field"
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp"

export function VerificationCode({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  disabled: boolean
}) {
  return (
    <Field>
      <FieldLabel htmlFor="authenticator-code">Authentication code</FieldLabel>
      <InputOTP
        id="authenticator-code"
        maxLength={6}
        value={value}
        onChange={onChange}
        pattern="^[0-9]+$"
        inputMode="numeric"
        autoComplete="one-time-code"
        disabled={disabled}
        required
      >
        <InputOTPGroup>
          {Array.from({ length: 6 }, (_, index) => (
            <InputOTPSlot
              key={index}
              index={index}
              className="size-11 text-xl sm:size-12"
            />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </Field>
  )
}
