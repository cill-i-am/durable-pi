import { Context, Effect, Exit, Layer, Scope } from "effect"

import { BotConfigurationStore } from "../../src/agents/adapters/configuration"
import { homeAgentId } from "../../src/agents/domain"
import { conversationTransactions } from "../../src/conversations/adapters/sqlite-journal"
import { ConversationStore } from "../../src/conversations/adapters/sqlite-turns"
import { resumeAttachments } from "../../src/conversations/attachments"
import { workspaceLayer } from "../../src/workspace/adapters/storage"
import { WorkspaceAdmission } from "../../src/workspace/admission"
import { prepareAttachments } from "../../src/workspace/attachments"
import { Workspace } from "../../src/workspace/workspace"
import { nativeDatabase } from "./database"

/** Kill/restart leaves the admitted request and workspace extraction job intact. */
export async function probeAttachments(
  storage: DurableObjectStorage,
  phase: number
) {
  const scope = Scope.makeUnsafe()
  try {
    const db = nativeDatabase(storage, scope),
      conversations = new ConversationStore(db, {
        model: "gpt-6.1-sol",
        thinking: "medium",
      }),
      configuration = new BotConfigurationStore(db)
    const fileId = "88888888-8888-4888-8888-888888888888",
      id = "99999999-9999-4999-8999-999999999999"
    return await Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          workspaceLayer(
            db,
            {
              put: async (key, bytes) =>
                storage.put(`fixture-file:${key}`, bytes),
              get: async (key) => {
                const bytes = await storage.get<Uint8Array>(
                  `fixture-file:${key}`
                )
                return bytes
                  ? {
                      body: new Blob([new Uint8Array(bytes)]).stream(),
                      arrayBuffer: async () => new Uint8Array(bytes).buffer,
                    }
                  : null
              },
            },
            "native-attachments",
            () => Effect.succeed(true),
            {
              document: () =>
                Effect.succeed({
                  text: "NATIVE_PREPARATION_RESTART_OK",
                  pages: 1,
                  readPages: 1,
                  truncated: false,
                }),
            }
          )
        )
        const workspace = Context.get(context, Workspace),
          files = Context.get(context, WorkspaceAdmission)
        if (phase === 0) {
          yield* configuration.configure("owner", {
            id: homeAgentId,
            slug: "test",
            name: "Test",
            instructions: "",
            revision: 0,
            status: "active",
            createdAt: "legacy",
            updatedAt: "legacy",
          })
          yield* workspace.upload({
            id: fileId,
            name: "restart.pdf",
            mime: "application/pdf",
            bytes: new TextEncoder().encode("%PDF-native-fixture"),
          })
          yield* conversations.admit(
            { operationId: id, text: "Read after restart", files: [fileId] },
            yield* prepareAttachments(workspace, [fileId]),
            [],
            undefined,
            // This store-only probe resumes extraction explicitly after restart.
            { discoveryDeadline: Date.now() + 60_000 }
          )
        } else {
          yield* workspace.extractNext()
          yield* resumeAttachments(
            conversations,
            workspace,
            configuration,
            files,
            conversationTransactions(db)
          )((yield* conversations.get(id))!)
        }
        const turn = (yield* conversations.get(id))!
        return {
          id: turn.id,
          pending: turn.files_pending,
          input: JSON.stringify(turn.input),
          status: turn.status,
          files: turn.attachments.length,
          jobPending: yield* workspace.extractionPending(),
        }
      }).pipe(Effect.provideService(Scope.Scope, scope))
    )
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
}
