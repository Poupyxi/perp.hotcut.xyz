import { createFileRoute } from "@tanstack/react-router";
import { VerifiedListedPage } from "@/components/app/VerifiedListedPage";

export const Route = createFileRoute("/_app/verified-listed")({
  component: VerifiedListedPage,
  head: () => ({ meta: [{ title: "Verified Listed — Perp RWA" }] }),
});
