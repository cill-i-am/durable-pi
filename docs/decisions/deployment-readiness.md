# Verify the running deployment revision

Date: 2026-10-19

## Decision

A successful upload does not mean existing Durable Objects serve the uploaded code. Stamp the website and agent code with the deployment commit at bundle time. The production check waits up to eight minutes for the website, agent Worker and every active agent in the owner's catalogue to acknowledge the expected revision before checking the existing hosted pages and authentication rules.

Use one protected `/api/deployment` read with CI's existing setup capability. The server selects the configured owner; callers cannot provide an account or object name. Return revisions only, with no-store caching. Native actor methods read their code stamp and catalogue without starting lifecycle/model work, configuring profiles or changing conversation state. No extra actor, database, provider API access or secret is needed.

During rolling updates, missing methods, unavailable producers and mismatched stamps remain unready; they never fall back to success. A timeout fails deployment verification without automatically restarting agents or replaying user work. This is a sampled readiness observation at the time of the check, not a claim about every Cloudflare location or downstream inbox delivery.

## Evidence

The previous release's existing personal agent briefly served the old response contract after upload completed. Cloudflare documents eventual consistency between Worker and Durable Object code updates: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/#code-updates.
