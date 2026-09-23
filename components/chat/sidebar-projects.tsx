"use client";

import {
  AudioWaveform,
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
  href: string;
  icon: LucideIcon;
  name: string;
};

const serviceOrigin = (
  process.env.NEXT_PUBLIC_SERVICE_ORIGIN ?? "https://videohead.duckdns.org"
).replace(/\/$/, "");

const projects: Project[] = [
  {
    href: `${serviceOrigin}/worldgraphstudio/`,
    icon: GitBranch,
    name: "WorldGraphStudio",
  },
  { href: `${serviceOrigin}/comfy/`, icon: Layers, name: "ComfyUI" },
  { href: `${serviceOrigin}/morphazoid/`, icon: Brain, name: "Morphazoid" },
  { href: `${serviceOrigin}/videobrain/`, icon: Film, name: "VideoBrain" },
  {
    href: "https://audiobrain.org/",
    icon: AudioWaveform,
    name: "AudioBrain",
  },
  { href: `${serviceOrigin}/vllm/v1/models`, icon: Cpu, name: "vLLM" },
  {
    href: `${serviceOrigin}/agent-framework`,
    icon: Bot,
    name: "Agent Framework",
  },
  {
    href: `${serviceOrigin}/litellm/health/liveliness`,
    icon: Network,
    name: "LiteLLM",
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
                  href={project.href}
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
