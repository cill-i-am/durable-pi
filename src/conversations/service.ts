import { Context, Layer } from "effect"

import type { ConversationLedger } from "./ledger"
import type {
  ConversationConflict,
  ConversationFull,
  ConversationStorageError,
} from "./turns"

export type ConversationError =
  | ConversationConflict
  | ConversationFull
  | ConversationStorageError
export type ConversationOperations = Omit<
  ConversationLedger,
  "transactionGroup"
>
export class Conversations extends Context.Service<
  Conversations,
  ConversationOperations
>()("durable-pi/conversations/Conversations") {}

export const makeConversations = (
  ledger: ConversationLedger
): ConversationOperations => ledger
export const conversationApplication = (ledger: ConversationLedger) =>
  Layer.succeed(Conversations, makeConversations(ledger))
