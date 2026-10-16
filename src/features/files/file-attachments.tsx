import { FileText, Film, X } from "lucide-react"

import {
  Attachment,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentActions,
  AttachmentAction,
  AttachmentTrigger,
} from "@/components/ui/attachment"
import { agentUrl } from "@/http/client"
import type { FileInfo } from "@/workspace/files"

import { fileDescription, preparingFile } from "./preparation"

export function fileSize(size: number) {
  return size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(size / 1024))} KB`
}
export function FileAttachments({
  files,
  agentId,
  onRemove,
}: {
  files: readonly FileInfo[]
  agentId: string
  onRemove?: (id: string) => void
}) {
  if (!files.length) return null
  return (
    <div className="conversation-attachments">
      {files.map((file) => (
        <Attachment
          key={file.id}
          size="sm"
          className="conversation-attachment"
          state={
            file.status === "uploading"
              ? "uploading"
              : preparingFile(file)
                ? "processing"
                : file.video?.status === "failed" ||
                    file.extraction?.status === "failed"
                  ? "error"
                  : "done"
          }
        >
          <AttachmentMedia variant={file.kind === "image" ? "image" : "icon"}>
            {file.kind === "image" ? (
              <img
                src={agentUrl(agentId, `files/${file.id}/vision`)}
                alt=""
                loading="lazy"
              />
            ) : file.kind === "video" ? (
              <Film />
            ) : (
              <FileText />
            )}
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>{file.name}</AttachmentTitle>
            <AttachmentDescription>
              {fileSize(file.size)} · {fileDescription(file)}
            </AttachmentDescription>
          </AttachmentContent>
          <AttachmentTrigger
            render={
              <a
                aria-label={`Download ${file.name}`}
                href={
                  agentUrl(agentId, `files/${file.id}/content`) + "&download=1"
                }
                download
              />
            }
            aria-label={`Download ${file.name}`}
          />
          {onRemove && (
            <AttachmentActions>
              <AttachmentAction
                aria-label={`Remove ${file.name} from message`}
                onClick={() => onRemove(file.id)}
              >
                <X />
              </AttachmentAction>
            </AttachmentActions>
          )}
        </Attachment>
      ))}
    </div>
  )
}
