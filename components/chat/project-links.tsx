import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";

const projects = [
  { href: "/morphazoid", name: "Morphazoid" },
  { href: "/videobrain", name: "Videobrain" },
  { href: "/worldgraphstudio", name: "WorldGraph Studio" },
];

export function ProjectLinks({ compact = false }: { compact?: boolean }) {
  return (
    <nav aria-label="Projects" className={compact ? "" : "mt-8"}>
      <p className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
        Projects
      </p>
      <div className={compact ? "flex flex-col gap-1" : "grid gap-2 sm:grid-cols-3"}>
        {projects.map((project) => (
          <Link
            className="group flex items-center justify-between rounded-lg border border-border/60 px-3 py-2 text-sm transition-colors hover:border-border hover:bg-muted/60"
            href={project.href}
            key={project.href}
            rel="noopener noreferrer"
            target="_blank"
          >
            <span>{project.name}</span>
            <ExternalLinkIcon className="size-3.5 text-muted-foreground transition-colors group-hover:text-foreground" />
          </Link>
        ))}
      </div>
    </nav>
  );
}