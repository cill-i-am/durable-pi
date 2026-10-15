import { nativeByteStream, nativeBytes } from "../../shared/stream"
import { WorkspaceUnavailable } from "../files"

export const workspaceByteStream = (open: () => ReadableStream<Uint8Array>) =>
  nativeByteStream(open, () => new WorkspaceUnavailable())

export const workspaceBytes = <TError>(
  body: ReadableStream<Uint8Array>,
  maximum: number,
  tooLarge: () => TError
) => nativeBytes(body, maximum, () => new WorkspaceUnavailable(), tooLarge)
