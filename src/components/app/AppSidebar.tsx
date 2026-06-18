import { Link, useRouterState } from "@tanstack/react-router";
import { LayoutDashboard, Layers, BadgeCheck, List, Dices, SlidersHorizontal } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
} from "@/components/ui/sidebar";

const nav = [
  { title: "Market Overview", url: "/dashboard", icon: LayoutDashboard },
  { title: "Markets", url: "/collections", icon: Layers },
  { title: "Listed NFTs", url: "/verified-listed", icon: BadgeCheck },
  { title: "NFT List", url: "/nft-list", icon: List },
];

const labNav = [
  { title: "Gacha (devnet)", url: "/gacha", icon: Dices },
  { title: "Control Panel", url: "/control-panel", icon: SlidersHorizontal },
];

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (url: string) => pathname === url || pathname.startsWith(url + "/");

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader className="border-b border-sidebar-border">
        <Link to="/" className="flex items-center gap-2.5 px-2 py-2.5">
          <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-md bg-surface-raised ring-1 ring-primary/35 shadow-[0_0_18px_oklch(0.62_0.225_258_/_0.16)]">
            <img src="/perp-rwa-logo-icon.png" alt="" className="h-8 w-8 object-cover" />
          </div>
          <div className="flex flex-col leading-tight group-data-[collapsible=icon]:hidden">
            <span className="text-sm font-semibold tracking-tight">Perp RWA</span>
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Market Intelligence</span>
          </div>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Intelligence</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {nav.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton asChild isActive={isActive(item.url)} tooltip={item.title}>
                    <Link to={item.url}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Lab (devnet)</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {labNav.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton asChild isActive={isActive(item.url)} tooltip={item.title}>
                    <Link to={item.url}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <div className="px-2 py-2 text-[10px] text-muted-foreground group-data-[collapsible=icon]:hidden">
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
            Live metadata · v0.1
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
