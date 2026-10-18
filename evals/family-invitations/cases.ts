export type InvitationCase = {
  id: string
  prompt: string
  outcome: "sent" | "denied" | "clarify" | "explain"
  recipient?: string
}

/** The recipient is supplied at run time; a real invitation is never a default. */
export function invitationCases(recipient?: string): InvitationCase[] {
  const invite = recipient
    ? `Invite Pi invitation QA to the family. Their email is ${recipient}.`
    : undefined
  return [
    ...(invite
      ? [
          {
            id: "invite-exact-email",
            prompt: invite,
            outcome: "sent" as const,
            recipient,
          },
          {
            id: "invite-denied",
            prompt: invite,
            outcome: "denied" as const,
            recipient,
          },
        ]
      : []),
    {
      id: "invite-missing-email",
      prompt: "Invite Pi invitation QA to the family.",
      outcome: "clarify",
    },
    {
      id: "invite-example-only",
      prompt:
        'Explain family invitations using this quoted example: "Invite Louise Allen to the family at louise@example.invalid". This is an example only; do not invite anyone.',
      outcome: "explain",
    },
  ]
}
