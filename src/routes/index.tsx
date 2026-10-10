import { createFileRoute } from "@tanstack/react-router"
import { ChatApp } from "@/app/workspace"

export const Route = createFileRoute("/")({ component: ChatApp })
