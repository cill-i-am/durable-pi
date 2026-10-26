import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@workspace/ui/components/alert-dialog"
import { Button } from "@workspace/ui/components/button"
import {
  CardFrame,
  CardFrameFooter,
  CardPanel,
} from "@workspace/ui/components/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@workspace/ui/components/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetNavigation,
  SheetTitle,
  SheetTrigger,
} from "@workspace/ui/components/sheet"
import { ChevronRightIcon, CpuIcon, UsersIcon } from "lucide-react"
import * as React from "react"

import { useLab } from "../state/use-lab"

export type Scenario = "success" | "error" | "uncertain" | "hold"
export type DrawerArgs = {
  startAt: "closed" | "root" | "child" | "third"
  scenario: Scenario
  longContent: boolean
  title: string
  backLabel: string
}

export function Outcome({
  lab,
  operation = "save",
}: {
  lab: ReturnType<typeof useLab>
  operation?: "save" | "disconnect"
}) {
  if (lab.status === "success")
    return (
      <p className="drawer-lab-outcome" role="status">
        {operation === "disconnect"
          ? "Connection disconnected."
          : "Changes saved."}
      </p>
    )
  if (lab.status === "cancelled")
    return (
      <p className="drawer-lab-outcome" role="status">
        {operation === "disconnect"
          ? "Disconnect cancelled. No automatic retry."
          : "Save cancelled. Your draft is kept."}
      </p>
    )
  if (lab.status === "error")
    return (
      <p className="drawer-lab-outcome" data-error="true" role="alert">
        {operation === "disconnect"
          ? "Couldn’t disconnect. Retry the same request or close the example."
          : lab.error}
      </p>
    )
  if (lab.status === "uncertain")
    return (
      <p className="drawer-lab-outcome" role="status">
        {operation === "disconnect"
          ? "The disconnect is unconfirmed. Check its status before trying again."
          : "The save is unconfirmed. Check its status before trying again."}
      </p>
    )
  return null
}

export function SaveActions({ lab }: { lab: ReturnType<typeof useLab> }) {
  if (lab.busy)
    return (
      <>
        <Button variant="outline" onClick={lab.cancel}>
          Cancel save
        </Button>
        <Button disabled aria-busy="true">
          Saving…
        </Button>
      </>
    )
  if (lab.status === "uncertain")
    return <Button onClick={lab.check}>Check status</Button>
  if (lab.status === "error")
    return <Button onClick={lab.retry}>Retry save</Button>
  if (lab.status === "success" || lab.status === "cancelled")
    return (
      <Button variant="outline" onClick={lab.reset}>
        Edit again
      </Button>
    )
  return (
    <Button
      {...lab.interactionProps}
      disabled={lab.disabled}
      onClick={lab.start}
    >
      Save changes
    </Button>
  )
}

export function AccessDraft({
  lab,
  longContent,
}: {
  lab: ReturnType<typeof useLab>
  longContent: boolean
}) {
  const id = React.useId()
  return (
    <>
      <CardFrame className="drawer-lab-frame">
        <CardPanel>
          <FieldGroup className="drawer-lab-fields">
            <Field>
              <FieldLabel htmlFor={id}>Connection name</FieldLabel>
              <Input
                id={id}
                defaultValue="Family ChatGPT"
                disabled={lab.busy}
              />
              <FieldDescription>Name shown to your family.</FieldDescription>
            </Field>
          </FieldGroup>
          <Outcome lab={lab} />
        </CardPanel>
        <CardFrameFooter variant="actions">
          <SaveActions lab={lab} />
        </CardFrameFooter>
      </CardFrame>
      {longContent && (
        <div className="drawer-lab-history" aria-label="Recent activity">
          {Array.from({ length: 18 }, (_, index) => (
            <p key={index}>
              Connection review {index + 1}. Earlier replies keep the model they
              started with. New settings apply to future requests.
            </p>
          ))}
        </div>
      )}
    </>
  )
}

export function DrawerStack({
  startAt,
  scenario,
  longContent,
  title,
  backLabel,
}: DrawerArgs) {
  const lab = useLab({ scenario, identity: "drawer-model-access" })
  return (
    <main className="drawer-lab">
      <Sheet defaultOpen={startAt !== "closed"} dismissible={!lab.busy}>
        <SheetTrigger render={<Button />}>Open settings</SheetTrigger>
        <SheetContent keepMounted showCloseButton={false}>
          <SheetNavigation title="Settings" closeLabel="Close settings" />
          <SheetBody>
            <CardFrame className="drawer-lab-frame">
              <CardPanel>
                <Sheet
                  defaultOpen={startAt === "child" || startAt === "third"}
                  dismissible={!lab.busy}
                >
                  <SheetTrigger
                    render={
                      <Button variant="ghost" className="drawer-lab-row" />
                    }
                  >
                    <UsersIcon aria-hidden="true" />
                    <span>Family</span>
                    <ChevronRightIcon aria-hidden="true" />
                  </SheetTrigger>
                  <SheetContent keepMounted showCloseButton={false}>
                    <SheetNavigation
                      title="Family"
                      backLabel="Settings"
                      closeLabel="Close family"
                    />
                    <SheetBody>
                      <CardFrame className="drawer-lab-frame">
                        <CardPanel>
                          <Sheet
                            defaultOpen={startAt === "third"}
                            dismissible={!lab.busy}
                          >
                            <SheetTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  className="drawer-lab-row"
                                />
                              }
                            >
                              <CpuIcon aria-hidden="true" />
                              <span>Model access</span>
                              <ChevronRightIcon aria-hidden="true" />
                            </SheetTrigger>
                            <SheetContent keepMounted showCloseButton={false}>
                              <SheetNavigation
                                title={title}
                                backLabel={backLabel}
                                closeLabel="Close model access"
                              />
                              <SheetBody>
                                <AccessDraft
                                  lab={lab}
                                  longContent={longContent}
                                />
                              </SheetBody>
                            </SheetContent>
                          </Sheet>
                        </CardPanel>
                      </CardFrame>
                    </SheetBody>
                  </SheetContent>
                </Sheet>
              </CardPanel>
            </CardFrame>
          </SheetBody>
        </SheetContent>
      </Sheet>
      <p className="drawer-lab-status" role="status">
        {lab.busy
          ? "A save is in progress. Dismissal is guarded."
          : "Settings are ready."}
      </p>
    </main>
  )
}

export function DialogExample({ scenario }: { scenario: Scenario }) {
  const lab = useLab({ scenario, identity: "dialog-family-name" })
  const id = React.useId()
  return (
    <main className="drawer-lab">
      <Dialog dismissible={!lab.busy}>
        <DialogTrigger render={<Button />}>Edit family</DialogTrigger>
        <DialogContent keepMounted>
          <DialogHeader>
            <DialogTitle>Family settings</DialogTitle>
            <DialogDescription>
              Choose the name shown to everyone in the family.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={id}>Family name</FieldLabel>
              <Input id={id} defaultValue="The Barrons" disabled={lab.busy} />
            </Field>
          </FieldGroup>
          <Outcome lab={lab} />
          <DialogFooter>
            <SaveActions lab={lab} />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

export function DesktopSheetExample({ scenario }: { scenario: Scenario }) {
  const lab = useLab({ scenario, identity: "desktop-model-access" })
  return (
    <main className="drawer-lab">
      <Sheet dismissible={!lab.busy}>
        <SheetTrigger render={<Button />}>Open model access</SheetTrigger>
        <SheetContent keepMounted>
          <SheetHeader>
            <SheetTitle>Model access</SheetTitle>
            <SheetDescription>
              Manage the connection used by your family.
            </SheetDescription>
          </SheetHeader>
          <SheetBody>
            <AccessDraft lab={lab} longContent={false} />
          </SheetBody>
          <SheetFooter>
            <span className="drawer-lab-status">
              Changes apply to future requests.
            </span>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </main>
  )
}

export function ConfirmationExample({ scenario }: { scenario: Scenario }) {
  const lab = useLab({ scenario, identity: "disconnect-fixture-connection" })
  return (
    <main className="drawer-lab">
      <AlertDialog dismissible={!lab.busy}>
        <AlertDialogTrigger render={<Button variant="outline" />}>
          Disconnect connection
        </AlertDialogTrigger>
        <AlertDialogContent keepMounted>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {lab.status === "success"
                ? "Connection disconnected"
                : "Disconnect this connection?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {lab.status === "success"
                ? "New tool calls are stopped for this simulated connection. Actions already sent may finish."
                : "New tool calls will stop for all assistants. Actions already sent may finish."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Outcome lab={lab} operation="disconnect" />
          <AlertDialogFooter>
            {lab.busy ? (
              <Button variant="outline" onClick={lab.cancel}>
                Cancel request
              </Button>
            ) : (
              <AlertDialogCancel>
                {lab.status === "success" || lab.status === "uncertain"
                  ? "Close"
                  : "Keep connection"}
              </AlertDialogCancel>
            )}
            {lab.status === "uncertain" ? (
              <Button onClick={lab.check}>Check status</Button>
            ) : lab.status === "error" ? (
              <Button onClick={lab.retry}>Retry request</Button>
            ) : lab.status !== "success" ? (
              <AlertDialogAction
                variant="destructive"
                {...lab.interactionProps}
                disabled={lab.disabled}
                onClick={lab.start}
              >
                {lab.busy ? "Disconnecting…" : "Disconnect"}
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}
