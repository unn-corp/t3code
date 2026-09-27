import { Link, useLocation } from "@tanstack/react-router";
import { NetworkIcon } from "lucide-react";

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

export function OrganizationsSidebarButton() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const active = pathname === "/organizations" || pathname.startsWith("/organizations/");

  return (
    <SidebarMenuItem data-organizations-sidebar-item>
      <SidebarMenuButton
        isActive={active}
        tooltip="Organizations"
        render={
          <Link
            to="/organizations"
            onClick={() => {
              if (isMobile) setOpenMobile(false);
            }}
          />
        }
      >
        <NetworkIcon />
        <span>Organizations</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
