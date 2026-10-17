import { Monitor, Moon, Sparkles, Sun } from "lucide-react"

import { ActivityBorder, ActivityOrb } from "@/components/activity-visuals"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useActivityMotion } from "@/hooks/activity-motion"
import { useAppTheme } from "@/hooks/use-app-theme"

const themes = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const
export function ThemeMenu() {
  const { theme, setTheme, resolvedTheme, ready } = useAppTheme()
  const Icon =
    !ready || theme === "system"
      ? Monitor
      : resolvedTheme === "dark"
        ? Moon
        : Sun
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" disabled={!ready} />}
        aria-label="Appearance"
      >
        <Icon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Appearance</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
            {themes.map((item) => (
              <DropdownMenuRadioItem key={item.value} value={item.value}>
                <item.icon /> {item.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AppearanceSettings() {
  const { theme, setTheme, ready } = useAppTheme()
  const motion = useActivityMotion()
  return (
    <>
      <div className="settings-preference appearance-preference">
        <div>
          <h3 id="theme-label">Appearance</h3>
          <p>Choose a theme for this device.</p>
        </div>
        <ToggleGroup
          aria-labelledby="theme-label"
          value={[theme]}
          disabled={!ready}
          onValueChange={(values) => {
            const selected = values[0]
            if (selected && themes.some((item) => item.value === selected))
              setTheme(selected)
          }}
          variant="outline"
          size="sm"
          spacing={0}
        >
          {themes.map((item) => (
            <ToggleGroupItem
              key={item.value}
              value={item.value}
              aria-label={item.label}
              className="min-h-9 max-md:min-h-11"
            >
              <item.icon /> {item.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="settings-preference">
        <Sparkles />
        <div>
          <h3 id="motion-label">Activity animations</h3>
          <p id="motion-description">
            Orbs and a subtle border while your agent works.
            {motion.reduced ? " Reduced motion is on for this device." : ""}
          </p>
        </div>
        <Switch
          aria-labelledby="motion-label"
          aria-describedby="motion-description"
          checked={motion.enabled}
          onCheckedChange={motion.setEnabled}
        />
      </div>
      <ActivityBorder active>
        <div className="appearance-preview">
          <ActivityOrb state="searching" />
          <span>Activity preview</span>
        </div>
      </ActivityBorder>
    </>
  )
}
