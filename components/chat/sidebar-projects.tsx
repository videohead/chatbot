"use client";

import {
  Box,
  Brain,
  Bot,
  Cpu,
  Film,
  GitBranch,
  Layers,
  Network,
  type LucideIcon,
} from "lucide-react";
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
  name: string;
  href: string;
  icon: LucideIcon;
};

const projects: Project[] = [
  { name: "WorldGraphStudio", href: "/worldgraphstudio", icon: GitBranch },
  { name: "ComfyUI", href: "/comfy", icon: Layers },
  { name: "Morphazoid", href: "/morphazoid/", icon: Brain },
  { name: "VideoBrain", href: "/videobrain", icon: Film },
  { name: "vLLM", href: "/vllm", icon: Cpu },
  { name: "Agent Framework", href: "/agent-framework", icon: Bot },
  { name: "LiteLLM", href: "/litellm", icon: Network },
];

export function SidebarProjects() {
  const { setOpenMobile } = useSidebar();

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
                  href={project.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpenMobile(false)}
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
