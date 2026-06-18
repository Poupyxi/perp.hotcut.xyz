import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/verified-sales")({
  beforeLoad: () => {
    throw redirect({ to: "/verified-listed" });
  },
});
