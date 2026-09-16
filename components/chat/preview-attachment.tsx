import Image from "next/image";
import type { Attachment } from "@/lib/types";
import { Spinner } from "../ui/spinner";
import { CrossSmallIcon } from "./icons";

function previewUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (
      ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) &&
      parsed.pathname.includes("/api/media/files/")
    ) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // Relative same-origin URLs are already safe for Next Image.
  }
  return url;
}

export const PreviewAttachment = ({
  attachment,
  isUploading = false,
  onRemove,
}: {
  attachment: Attachment;
  isUploading?: boolean;
  onRemove?: () => void;
}) => {
  const { name, url, contentType } = attachment;
  const src = previewUrl(url);

  return (
    <div
      className="group relative h-24 w-24 shrink-0 overflow-hidden rounded-xl border border-border/40 bg-muted"
      data-testid="input-attachment-preview"
    >
      {contentType?.startsWith("image") ? (
        <Image
          alt={name ?? "attachment"}
          className="size-full object-cover"
          height={96}
          src={src}
          width={96}
        />
      ) : contentType?.startsWith("video") ? (
        <video
          aria-label={name ?? "video attachment"}
          className="size-full object-cover"
          muted
          playsInline
          preload="metadata"
          src={src}
        />
      ) : (
        <div className="flex size-full items-center justify-center text-muted-foreground text-xs">
          File
        </div>
      )}

      {isUploading ? (
        <div
          className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/40 backdrop-blur-sm"
          data-testid="input-attachment-loader"
        >
          <Spinner className="size-5" />
        </div>
      ) : null}

      {onRemove && !isUploading && (
        <button
          className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 backdrop-blur-sm transition-opacity hover:bg-black/80 group-hover:opacity-100"
          onClick={onRemove}
          type="button"
        >
          <CrossSmallIcon size={10} />
        </button>
      )}
    </div>
  );
};
