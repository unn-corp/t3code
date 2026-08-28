import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  LayoutDashboardIcon,
  ListFilterIcon,
  ListChecksIcon,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";

import { cn } from "~/lib/utils";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "../ui/sidebar";

type AgentDashboardPath =
  | "/agent-dashboard"
  | "/agent-dashboard/findings"
  | "/agent-dashboard/runs";

type AgentDashboardNavItem = {
  readonly label: string;
  readonly to: AgentDashboardPath;
  readonly icon: LucideIcon;
};

const AGENT_DASHBOARD_NAV_ITEMS = [
  { label: "Overview", to: "/agent-dashboard", icon: LayoutDashboardIcon },
  { label: "Findings", to: "/agent-dashboard/findings", icon: ListFilterIcon },
  { label: "Runs", to: "/agent-dashboard/runs", icon: ListChecksIcon },
] as const satisfies readonly AgentDashboardNavItem[];

const AGENT_DASHBOARD_SUBMENU_ID = "agent-dashboard-sidebar-submenu";

export function AgentDashboardSidebarButton() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const isAgentDashboardRoute =
    pathname === "/agent-dashboard" || pathname.startsWith("/agent-dashboard/");
  const [isExpanded, setIsExpanded] = useState(isAgentDashboardRoute);

  useEffect(() => {
    setIsExpanded(isAgentDashboardRoute);
  }, [isAgentDashboardRoute]);

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);

  const openDashboard = useCallback(() => {
    setIsExpanded(true);
    closeMobileSidebar();
    void navigate({ to: "/agent-dashboard" });
  }, [closeMobileSidebar, navigate]);

  const toggleExpanded = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsExpanded((expanded) => !expanded);
  }, []);

  return (
    <SidebarMenuItem data-agent-dashboard-sidebar-item>
      <SidebarMenuButton
        type="button"
        isActive={isAgentDashboardRoute}
        onClick={openDashboard}
        tooltip="Agent Dashboard"
        data-agent-dashboard-sidebar-button
      >
        <LayoutDashboardIcon />
        <span>Agent Dashboard</span>
      </SidebarMenuButton>
      <SidebarMenuAction
        type="button"
        aria-controls={AGENT_DASHBOARD_SUBMENU_ID}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? "Collapse" : "Expand"} Agent Dashboard`}
        onClick={toggleExpanded}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn("transition-transform duration-150", isExpanded && "rotate-90")}
        />
      </SidebarMenuAction>
      {isExpanded ? (
        <SidebarMenuSub id={AGENT_DASHBOARD_SUBMENU_ID}>
          {AGENT_DASHBOARD_NAV_ITEMS.map(({ icon: Icon, label, to }) => {
            const isActive = pathname === to;
            return (
              <SidebarMenuSubItem key={to}>
                <SidebarMenuSubButton
                  isActive={isActive}
                  aria-current={isActive ? "page" : undefined}
                  render={<Link to={to} onClick={closeMobileSidebar} />}
                >
                  <Icon />
                  <span>{label}</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            );
          })}
        </SidebarMenuSub>
      ) : null}
    </SidebarMenuItem>
  );
}
