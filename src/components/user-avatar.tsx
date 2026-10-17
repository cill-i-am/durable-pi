import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar"

export function UserAvatar({
  name,
  image,
  className,
}: {
  name: string
  image?: string | null
  className?: string
}) {
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "?"
  return (
    <Avatar className={className} aria-hidden="true">
      <AvatarImage src={image ?? undefined} alt="" />
      <AvatarFallback>{initials}</AvatarFallback>
    </Avatar>
  )
}
