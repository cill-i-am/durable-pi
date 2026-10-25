import { createEffectActor } from "@xstate/effect"
import { Effect } from "effect"

import { AVATAR_PATH } from "@/auth/avatar"
import { authClient, authFetch } from "@/auth/client"
import { errorMessage } from "@/http/client"
import { nativeOperation } from "@/shared/interop"

import { AuthIssue } from "./auth-contracts"
import { authNative, authOwner, useAuthActor } from "./auth-owner"
import { photoMachine, type PhotoWork } from "./photo.machine"
import { prepareAvatar } from "./prepare-avatar"

export function photoRequests(refetch: () => Promise<unknown>): PhotoWork {
  return {
    prepare: (file) =>
      nativeOperation(
        () => prepareAvatar(file),
        (cause) =>
          new AuthIssue({
            message:
              cause instanceof Error
                ? cause.message
                : "Could not prepare that photo.",
          })
      ),
    save: (photo) =>
      Effect.gen(function* () {
        const response = yield* authNative(
          (signal) =>
            authFetch(AVATAR_PATH, {
              method: photo ? "POST" : "DELETE",
              headers: photo ? { "content-type": photo.type } : undefined,
              body: photo,
              signal,
            }),
          "Could not confirm the photo update. Reload and try again."
        )
        if (!response.ok) {
          if (response.status === 401)
            return yield* Effect.fail(
              new AuthIssue({
                message: "Your session has expired. Sign in again.",
              })
            )
          const body = yield* authNative(
            () => response.json(),
            "Could not read the photo response."
          )
          return yield* Effect.fail(
            new AuthIssue({ message: errorMessage(body) })
          )
        }
      }),
    refresh: () =>
      Effect.gen(function* () {
        yield* authNative(
          refetch,
          "Your photo was saved. Reload to see the updated profile."
        )
        const result = yield* authNative(
          (signal) => authClient.getSession({ fetchOptions: { signal } }),
          "Your photo was saved. Reload to see the updated profile."
        )
        if (result.error)
          return yield* Effect.fail(
            new AuthIssue({
              message:
                "Your photo was saved. Reload to see the updated profile.",
            })
          )
      }),
  }
}
export function usePhoto(identity: string, refetch: () => Promise<unknown>) {
  return useAuthActor(identity, () =>
    authOwner((observe) => {
      const work = photoRequests(refetch)
      return createEffectActor(
        photoMachine({
          prepare: (file) => observe(work.prepare(file)),
          save: (photo) => observe(work.save(photo)),
          refresh: () => observe(work.refresh()),
        })
      )
    })
  )
}
