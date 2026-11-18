import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import { EmailWorker, WhatsAppWorker } from "./stacks/resources/channels"
import { Website } from "./stacks/resources/website"

export default Alchemy.Stack(
  "durable-pi",
  {
    providers: Cloudflare.providers(),
    state: Layer.unwrap(
      Effect.map(Alchemy.AlchemyContext, ({ dev }) =>
        dev ? Alchemy.localState() : Cloudflare.state()
      )
    ),
  },
  Effect.gen(function* () {
    const website = yield* Website
    yield* EmailWorker
    yield* WhatsAppWorker
    return { url: website.url }
  })
)
