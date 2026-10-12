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
        containerClassName="w-full"
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
        <InputOTPGroup className="w-full">
          {Array.from({ length: 6 }, (_, index) => (
            <InputOTPSlot
              key={index}
              index={index}
              className="h-11 min-w-0 flex-1 text-xl sm:h-12"
            />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </Field>
  )
}
