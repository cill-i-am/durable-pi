import { Cause, Schema } from "effect"
import type { Credential } from "@earendil-works/pi-ai"
import {
  CredentialStorageError,
  CredentialUnavailable,
  OAuthCredential,
} from "../credentials"
import { ModelCatalog, ModelUnavailable } from "../policy"
import { rpcOutcome } from "../../shared/rpc-outcome"
import { nativeOperation } from "../../shared/interop"

/** Account refresh/persistence authority never leaves the owner. */
export const AccountToken = Schema.Struct({
  type: OAuthCredential.fields.type,
  access: OAuthCredential.fields.access,
  expires: OAuthCredential.fields.expires,
  clientId: OAuthCredential.fields.clientId,
})
export const accountToken = (
  credential: OAuthCredential
): typeof AccountToken.Type => ({
  type: credential.type,
  access: credential.access,
  expires: credential.expires,
  clientId: credential.clientId,
})
export const nativeAccountToken = (
  token: typeof AccountToken.Type
): Credential => ({
  ...Schema.encodeSync(AccountToken)(token),
  refresh: "",
})
export const AccountRequest = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Credential"),
    provider: Schema.String,
  }),
  Schema.Struct({ _tag: Schema.Literal("Catalog") }),
])
export const AccountResult = Schema.Union([
  Schema.NullOr(AccountToken),
  ModelCatalog,
])
export const AccountFailure = Schema.Union([
  CredentialUnavailable,
  CredentialStorageError,
  ModelUnavailable,
])
export const AccountOutcome = rpcOutcome(
  AccountResult,
  AccountFailure,
  "Account model operation failed unexpectedly."
)

export function accountRpc(stub: {
  accountV1: (input: typeof AccountRequest.Type) => Promise<unknown>
}) {
  return {
    credential: (provider: string) =>
      stub
        .accountV1({ _tag: "Credential", provider })
        .then((raw) => AccountOutcome.unwrap(raw, Schema.NullOr(AccountToken))),
    catalog: () =>
      stub
        .accountV1({ _tag: "Catalog" })
        .then((raw) => AccountOutcome.unwrap(raw, ModelCatalog)),
  }
}
export const accountNative = <T>(start: () => Promise<T>) =>
  nativeOperation(start, (cause) => {
    const decoded = Schema.decodeUnknownOption(AccountFailure)(cause)
    return decoded._tag === "Some"
      ? decoded.value
      : new CredentialUnavailable({
          message:
            "The account model connection could not be confirmed. Try again later.",
        })
  })

export const AccountConnectionOutcome = rpcOutcome(
  Schema.Boolean,
  AccountFailure,
  "Account model connection failed unexpectedly."
)
export function accountConnectionRpc(stub: {
  modelConnectionV1?: () => Promise<unknown>
  modelConnected?: () => Promise<unknown>
}) {
  const legacy = () => {
    if (!stub.modelConnected)
      throw new CredentialUnavailable({
        message: "The account model connection could not be confirmed.",
      })
    return stub.modelConnected().then((raw) => {
      try {
        return Schema.decodeUnknownSync(Schema.Boolean)(raw)
      } catch (cause) {
        throw Cause.die(cause)
      }
    })
  }
  return {
    connected: () => {
      if (!stub.modelConnectionV1) return legacy()
      return stub.modelConnectionV1().then(
        (raw) => AccountConnectionOutcome.unwrap(raw, Schema.Boolean),
        (cause: unknown) => {
          if (
            Cause.isCause(cause) ||
            Schema.isSchemaError(cause) ||
            !stub.modelConnected
          )
            throw cause
          return legacy()
        }
      )
    },
  }
}
