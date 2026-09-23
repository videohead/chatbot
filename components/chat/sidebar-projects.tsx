"use client";

import {
  Bot,
  Brain,
  Cpu,
  Film,
  GitBranch,
  Layers,
  type LucideIcon,
  Network,
} from "lucide-react";
import { useCallback } from "react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

type Project = {
  icon: LucideIcon;
  name: string;
  path: string;
};

const serviceOrigin = (
  process.env.NEXT_PUBLIC_SERVICE_ORIGIN ?? "https://videohead.duckdns.org"
).replace(/\/$/, "");

const projects: Project[] = [
  { icon: GitBranch, name: "WorldGraphStudio", path: "/worldgraphstudio/" },
  { icon: Layers, name: "ComfyUI", path: "/comfy/" },
  { icon: Brain, name: "Morphazoid", path: "/morphazoid/" },
  { icon: Film, name: "VideoBrain", path: "/videobrain/" },
  { icon: Cpu, name: "vLLM", path: "/vllm/v1/models" },
  { icon: Bot, name: "Agent Framework", path: "/agent-framework" },
  {
    icon: Network,
    name: "LiteLLM",
    path: "/litellm/health/liveliness",
  },
];

export function SidebarProjects() {
  const { setOpenMobile } = useSidebar();
  const closeMobile = useCallback(() => setOpenMobile(false), [setOpenMobile]);

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel className="text-[10px] font-semibold uppercase tracking-[0.12em] text-sidebar-foreground/70">
        Projects
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {projects.map((project) => (
            <SidebarMenuItem key={project.name}>
              <SidebarMenuButton
                asChild
                className="h-8 rounded-lg text-[13px] text-sidebar-foreground/50 transition-colors duration-150 hover:bg-sidebar-accent hover:text-sidebar-foreground"
              >
                <a
                  href={`${serviceOrigin}${project.path}`}
                  onClick={closeMobile}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <project.icon className="size-4" />
                  <span className="truncate">{project.name}</span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
