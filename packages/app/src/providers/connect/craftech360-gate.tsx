import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
import { createEffect, onCleanup, onMount, Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useIntegrations } from "@/providers/catalog/integrations"
import { ServerProvider } from "@/runtime/server/current"
import { useServers } from "@/runtime/server/registry"
import { DialogConnectProvider, useProviderConnectController } from "./dialog"

export function Craftech360Gate() {
  const servers = useServers()
  const sidecar = () => servers.list.find((server) => server.type === "sidecar")

  return (
    <Show when={sidecar()} keyed>
      {(server) => (
        <ServerProvider conn={server}>
          <Craftech360SignIn />
        </ServerProvider>
      )}
    </Show>
  )
}

function Craftech360SignIn() {
  const integrations = useIntegrations(() => undefined)
  const dialog = useDialog()
  const gateID = "craftech360-sign-in"
  let disposed = false

  const available = () => integrations.list().some((integration) => integration.id === "craftech360")

  const connected = () =>
    integrations.list().some((integration) =>
      integration.id === "craftech360" && Boolean(integration.connections[0] && !integration.connections[0].status),
    )

  const open = () => {
    if (disposed || connected()) return
    void dialog.show(
      () => <Craftech360SignInDialog available={available} ready={integrations.ready} />,
      () => { if (!disposed && !connected()) queueMicrotask(open) },
      gateID,
    )
  }

  onMount(open)
  createEffect(() => { if (connected()) dialog.close(gateID) })
  onCleanup(() => { disposed = true; dialog.close(gateID) })

  return (
    <Show when={!connected()}>
      <div class="fixed inset-0 z-40 bg-v2-background-bg-base" />
    </Show>
  )
}

function Craftech360SignInDialog(props: { available: () => boolean; ready: () => boolean }) {
  const language = useLanguage()
  const dialog = useDialog()
  const controller = useProviderConnectController()

  const open = () => {
    controller.select("craftech360")
    void dialog.push(() => <DialogConnectProvider defaultLocation standalone controller={controller} />)
  }

  return (
    <Dialog fit preventBackdropDismiss>
      <DialogHeader hideClose><DialogTitle>{language.t("craftech360.signIn.title")}</DialogTitle></DialogHeader>
      <DialogBody>
        <p>{language.t("craftech360.signIn.description")}</p>
        <Button disabled={!props.ready() || !props.available()} onClick={open}>
          {language.t("craftech360.signIn.button")}
        </Button>
      </DialogBody>
    </Dialog>
  )
}
