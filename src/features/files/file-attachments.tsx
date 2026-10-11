import { FileText, Film, X } from "lucide-react"
import { fileDescription } from "./preparation"
import type { FileInfo } from "@/workspace/files"
import { agentUrl } from "@/http/client"
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
    <div className="flex min-w-0 flex-wrap gap-2 py-2">
      {files.map((file) => (
        <Attachment key={file.id} size="sm" className="max-w-full sm:max-w-64">
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
              {fileSize(file.size)}· {fileDescription(file)}
            </AttachmentDescription>
          </AttachmentContent>
          <AttachmentTrigger
            render={
              <a
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
