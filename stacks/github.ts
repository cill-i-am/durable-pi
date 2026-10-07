import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as GitHub from "alchemy/GitHub"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"

// Run this setup stack manually with an administrator profile. CI only receives
// the scoped deploy token, never the administrator credential.
export default Alchemy.Stack(
  "durable-pi-github",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment
    const expectedAccount = yield* Config.String("CLOUDFLARE_ACCOUNT_ID")
    if (accountId !== expectedAccount) {
      return yield* Effect.die(
        new Error("Cloudflare account does not match CI setup configuration")
      )
    }
    const repo = { owner: "cill-i-am", repository: "durable-pi" }
    const production = yield* GitHub.Environment("Production", {
      ...repo,
      name: "production",
      deploymentBranchPolicy: { customBranchPolicies: ["main"] },
    })
    const token = yield* Cloudflare.ApiToken.AccountApiToken("DeployToken", {
      accountId,
      name: "durable-pi-github-production",
      policies: [
        {
          effect: "allow",
          permissionGroups: [
            "Workers Scripts Read",
            "Workers Scripts Write",
            "D1 Read",
            "D1 Write",
            "Account Settings Read",
            "Secrets Store Read",
          ],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
      ],
    })
    const secrets = {
      CLOUDFLARE_API_TOKEN: token.value,
      CLOUDFLARE_ACCOUNT_ID: Redacted.make(accountId),
      BETTER_AUTH_SECRET: yield* Config.Redacted("BETTER_AUTH_SECRET"),
      SETUP_TOKEN: yield* Config.Redacted("SETUP_TOKEN"),
      OWNER_EMAIL: yield* Config.Redacted("OWNER_EMAIL"),
      OPENAI_CREDENTIAL: yield* Config.Redacted("OPENAI_CREDENTIAL"),
    }
    for (const [name, value] of Object.entries(secrets)) {
      yield* GitHub.Secret(name, {
        ...repo,
        environment: production,
        name,
        value,
      })
    }
    return { environment: production.name }
  })
)
