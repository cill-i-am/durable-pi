# Cards with an attached panel

Use `CardFrame` and `CardPanel` for the attached lower panel shown in the Paper Auth and Family cards. The frame owns the pale base and outer shadow. Its direct `Card` child keeps a fully rounded white surface, including its bottom corners. `CardPanel` sits below the complete card, including any `CardFooter` actions.

```tsx
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardFooter,
  CardFrame,
  CardHeader,
  CardPanel,
  CardTitle,
} from "@/components/ui/card"

function FamilyCard() {
  return (
    <CardFrame className="w-full max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>Name your family</CardTitle>
        </CardHeader>
        <CardContent>{/* Form fields */}</CardContent>
        <CardFooter>
          <Button>Create family</Button>
        </CardFooter>
      </Card>
      <CardPanel>
        <Button variant="link">Back</Button>
      </CardPanel>
    </CardFrame>
  )
}
```

Put width and placement classes on `CardFrame`. Keep the existing header, content, and footer composition inside `Card`. The panel wraps long content and grows beyond its 72px minimum height. Its background, 16px corners, and frame shadow come from the Paper cards; dark mode uses the shared surface tokens.

This is an optional composition. Ordinary cards retain their current appearance. The frame styles only its direct card and that card's direct footer, so nested cards retain their own borders, corners, and shadows. No page-specific styles are required.
