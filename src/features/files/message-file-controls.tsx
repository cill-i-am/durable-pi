import { FilePicker } from "./upload-controls"
import type { FilesState } from "./use-files"
import { VoiceRecorder } from "./voice-recorder"

export function MessageFileControls({
  files,
  sending,
}: {
  files: FilesState
  sending: boolean
}) {
  const disabled =
    !files.ready || sending || files.uploading || files.selected.length >= 4
  return (
    <>
      <FilePicker state={files} disabled={disabled} />
      <VoiceRecorder
        key={files.agentId}
        disabled={disabled}
        onRecorded={(file) => files.upload([file], true)}
      />
    </>
  )
}
