import * as Cloudflare from "@alchemy.run/cloudflare"

export const AuthDatabase = Cloudflare.D1.Database("AuthDatabase", {
  migrations: "./migrations/auth",
})
export const MemoryBackups = Cloudflare.R2.Bucket("MemoryBackups", {
  publicAccess: false,
})
export const WorkspaceAssets = Cloudflare.R2.Bucket("WorkspaceAssets", {
  publicAccess: false,
})
export const UserAvatars = Cloudflare.R2.Bucket("UserAvatars", {
  publicAccess: false,
})
