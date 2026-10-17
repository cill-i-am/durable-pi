import { useEffect, useRef, useState } from "react"

import { agentUrl } from "@/http/client"
import { agentApi } from "@/http/client"
import type { FileInfo } from "@/workspace/files"

export function AudioPlayer({
  file,
  agentId,
}: {
  file: FileInfo
  agentId: string
}) {
  const [transcript, setTranscript] = useState<string | null>(null)
  const [error, setError] = useState("")
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      {/* Audio-only recordings provide their text alternative in the disclosure below. */}
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        className="w-full max-w-full"
        aria-label={`Play ${file.name}`}
        controls
        preload="metadata"
        src={agentUrl(agentId, `files/${file.id}/content`)}
      />
      <details
        className="text-xs"
        onToggle={(event) => {
          if (!event.currentTarget.open || transcript !== null) return
          request.current?.abort()
          const controller = new AbortController()
          request.current = controller
          setError("")
          void (async () => {
            let next: number | null = 0
            let text = ""
            for (let page = 0; page < 2 && next !== null; page++) {
              const result: { text: string; next: number | null } =
                await agentApi(agentId)(
                  `files/${file.id}/text?offset=${next}&limit=20000`,
                  undefined,
                  controller.signal
                )
              text += result.text
              if (result.next !== null && result.next <= next)
                throw new Error("Transcript did not advance")
              next = result.next
            }
            if (next !== null) throw new Error("Transcript exceeded its bound")
            if (!controller.signal.aborted) setTranscript(text)
          })().catch(() => {
            if (!controller.signal.aborted)
              setError("Could not load the transcript. Open Files to retry.")
          })
        }}
      >
        <summary>Transcript</summary>
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <p className="whitespace-pre-wrap">
            {transcript ?? "Loading transcript…"}
          </p>
        )}
      </details>
    </div>
  )
}
