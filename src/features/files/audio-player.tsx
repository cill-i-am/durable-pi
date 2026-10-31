import { DataLoading } from "@workspace/ui/components/data-loading"
import { useEffect, useRef } from "react"

import { agentUrl } from "@/http/client"
import type { FileInfo } from "@/workspace/files"

import { useFilePreview } from "./use-file-preview"

export function AudioPlayer({
  file,
  agentId,
}: {
  file: FileInfo
  agentId: string
}) {
  const key = `${agentId}:${file.id}`
  const transcript = useFilePreview({
    key,
    agentId,
    fileId: file.id,
    kind: "transcript",
    eager: false,
  })
  const audio = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    const element = audio.current
    return () => {
      element?.pause()
      element?.removeAttribute("src")
      element?.load()
    }
  }, [key])
  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      {/* Audio-only recordings provide their text alternative in the disclosure below. */}
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        key={`audio-${key}`}
        ref={audio}
        className="w-full max-w-full"
        aria-label={`Play ${file.name}`}
        controls
        preload="metadata"
        src={agentUrl(agentId, `files/${file.id}/content`)}
      />
      <details
        key={`transcript-${key}`}
        className="text-xs"
        onToggle={(event) => transcript.toggle(event.currentTarget.open)}
      >
        <summary>Transcript</summary>
        {transcript.failed ? (
          <p role="alert">
            Could not load the transcript. Close and reopen it to retry.
          </p>
        ) : (
          <DataLoading
            loading={!transcript.value}
            label="Loading transcript"
            layout="conversation"
          >
            <p className="whitespace-pre-wrap">
              {transcript.value && "text" in transcript.value
                ? transcript.value.text
                : ""}
            </p>
          </DataLoading>
        )}
      </details>
    </div>
  )
}
