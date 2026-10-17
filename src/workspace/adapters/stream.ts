import { nativeByteStream, nativeBytes } from "../../shared/stream"
import { WorkspaceUnavailable } from "../files"

export const workspaceByteStream = (open: () => ReadableStream<unknown>) =>
  nativeByteStream(open, () => new WorkspaceUnavailable())

export const workspaceBytes = <TError>(
  body: ReadableStream<unknown>,
  maximum: number,
  tooLarge: () => TError
) => nativeBytes(body, maximum, () => new WorkspaceUnavailable(), tooLarge)
