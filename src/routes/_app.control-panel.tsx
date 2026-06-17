import { createFileRoute } from "@tanstack/react-router";
import { PingooProviders } from "@/components/app/gacha/PingooProviders";
import { PingooDashboard } from "@/components/app/gacha/PingooDashboard";

export const Route = createFileRoute("/_app/control-panel")({
  component: ControlPanelPage,
  head: () => ({ meta: [{ title: "Control Panel — Perp RWA" }] }),
});

function ControlPanelPage() {
  return (
    <PingooProviders>
      <PingooDashboard onBack={() => { window.history.back(); }} />
    </PingooProviders>
  );
}
