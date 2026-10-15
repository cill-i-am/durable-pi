import { nativeOperation, nativeResponse } from "../../shared/interop"
import { WorkspaceUnavailable } from "../files"

export const workspaceNativeOperation = <T>(
  start: (signal: AbortSignal) => Promise<T>
) => nativeOperation(start, () => new WorkspaceUnavailable())
export const workspaceResponse = (
  start: (signal: AbortSignal) => Promise<Response>
) => nativeResponse(start, () => new WorkspaceUnavailable())
