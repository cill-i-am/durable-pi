import { Agent, getAgentByName } from "agents"
import { createChatSdkState } from "agents/chat-sdk"

import { probeAttachments } from "./attachment-probe"
import { probeReplies } from "./reply-probe"

export {
  EmailRecoveryProbe,
  WhatsAppRecoveryProbe,
} from "./reply-recovery-probe"

export { ChatSdkStateAgent } from "agents/chat-sdk"

export class WhatsAppStateProbe extends Agent {
  async probe() {
    const state = createChatSdkState({ parent: this, name: "whatsapp-probe" })
    await state.connect()
    const previous = (await state.get<number>("whatsapp-counter")) ?? 0
    await state.set("whatsapp-counter", previous + 1)
    const lock = await state.acquireLock("whatsapp:123:owner", 5000)
    const duplicate = await state.acquireLock("whatsapp:123:owner", 5000)
    if (lock) await state.releaseLock(lock)
    await state.appendToList("history:probe", "one", {
      maxLength: 2,
      ttlMs: 5000,
    })
    await state.appendToList("history:probe", "two", {
      maxLength: 2,
      ttlMs: 5000,
    })
    await state.appendToList("history:probe", "three", {
      maxLength: 2,
      ttlMs: 5000,
    })
    const result = {
      counter: previous + 1,
      replies: await probeReplies(this.ctx.storage, previous),
      attachments: await probeAttachments(this.ctx.storage, previous),
      locked: !!lock,
      duplicate: !!duplicate,
      list: await state.getList("history:probe"),
    }
    await state.disconnect()
    return result
  }
}
export default {
  async fetch(
    request: Request,
    env: {
      PROBES: DurableObjectNamespace<WhatsAppStateProbe>
      EMAIL_RECOVERY: DurableObjectNamespace
      WHATSAPP_RECOVERY: DurableObjectNamespace
    }
  ) {
    if (new URL(request.url).pathname === "/health")
      return Response.json({ ok: true })
    const [, route, channel, name] = new URL(request.url).pathname.split("/")
    if (route === "replies") {
      const namespace =
        channel === "email" ? env.EMAIL_RECOVERY : env.WHATSAPP_RECOVERY
      return namespace.get(namespace.idFromName(name!)).fetch(request)
    }
    return Response.json(
      await (await getAgentByName(env.PROBES, "owner")).probe()
    )
  },
}
