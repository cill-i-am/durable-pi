// The standalone workerd binary omits Cloudflare's hosted routing constructor.
// These fixtures exercise native Pi/SQLite/Chat SDK state, never Agents email.
export class EmailMessage {
  constructor() {
    throw new Error("Agents email routing is outside this native fixture.")
  }
}
