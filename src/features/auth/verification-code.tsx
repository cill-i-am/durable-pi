import { Field, FieldLabel } from "@workspace/ui/components/field"

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
        <InputOTPGroup className="auth-entry-code-group">
          {Array.from({ length: 6 }, (_, index) => (
            <InputOTPSlot
              key={index}
              index={index}
              className="auth-entry-code-slot"
            />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </Field>
  )
}
