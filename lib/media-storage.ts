import { randomUUID } from "node:crypto";
import {
  chmod,
  chown,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";

const MEDIA_ROOT = join(process.cwd(), "generated-media");

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

const MEDIA_SIZE_LIMITS: Record<"image" | "video", number> = {
  image: 25 * 1024 * 1024,
  video: 500 * 1024 * 1024,
};

function ownerDirectory(userId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    throw new Error("Invalid media owner");
  }
  return join(MEDIA_ROOT, userId);
}

function localOwnerFor(userId: string) {
  if (process.env.MEDIA_LOCAL_OWNER_USER_ID !== userId) {
    return null;
  }
  const uid = Number.parseInt(process.env.MEDIA_LOCAL_OWNER_UID ?? "", 10);
  const gid = Number.parseInt(process.env.MEDIA_LOCAL_OWNER_GID ?? "", 10);
  if (
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    !Number.isSafeInteger(gid) ||
    gid < 0
  ) {
    return null;
  }
  return { gid, uid };
}

async function applyLocalOwnership(path: string, userId: string, mode: number) {
  const owner = localOwnerFor(userId);
  if (!owner) {
    return;
  }
  await chown(path, owner.uid, owner.gid);
  await chmod(path, mode);
}

export function storeGeneratedImage({
  bytes,
  mediaType,
  userId,
}: {
  bytes: Uint8Array;
  mediaType: string;
  userId: string;
}) {
  return storeGeneratedMedia({ bytes, kind: "image", mediaType, userId });
}

export function storeUploadedImage({
  bytes,
  mediaType,
  userId,
}: {
  bytes: Uint8Array;
  mediaType: string;
  userId: string;
}) {
  return storeGeneratedMedia({ bytes, kind: "image", mediaType, userId });
}

export function storeUploadedVideo({
  bytes,
  mediaType,
  userId,
}: {
  bytes: Uint8Array;
  mediaType: string;
  userId: string;
}) {
  return storeGeneratedMedia({ bytes, kind: "video", mediaType, userId });
}

export function storeGeneratedVideo({
  bytes,
  mediaType,
  userId,
}: {
  bytes: Uint8Array;
  mediaType: string;
  userId: string;
}) {
  return storeGeneratedMedia({ bytes, kind: "video", mediaType, userId });
}

async function storeGeneratedMedia({
  bytes,
  mediaType,
  userId,
  kind,
}: {
  bytes: Uint8Array;
  mediaType: string;
  userId: string;
  kind: "image" | "video";
}) {
  const extension = EXTENSIONS[mediaType];
  if (!extension || !mediaType.startsWith(`${kind}/`)) {
    throw new Error(`Unsupported generated ${kind} type`);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MEDIA_SIZE_LIMITS[kind]) {
    throw new Error(`Generated ${kind} has an invalid size`);
  }

  const directory = ownerDirectory(userId);
  await mkdir(directory, { mode: 0o700, recursive: true });
  await applyLocalOwnership(directory, userId, 0o700);
  const filename = `${randomUUID()}.${extension}`;
  const path = join(directory, filename);
  await writeFile(path, bytes, {
    flag: "wx",
    mode: 0o600,
  });
  await applyLocalOwnership(path, userId, 0o600);
  return { filename, url: `/api/media/files/${filename}` };
}

export function readOwnedMedia(userId: string, filename: string) {
  const safeFilename = basename(filename);
  if (
    safeFilename !== filename ||
    !/^[0-9a-f-]{36}\.(png|jpg|webp|mp4|webm)$/i.test(filename)
  ) {
    throw new Error("Invalid media filename");
  }
  return readFile(join(ownerDirectory(userId), safeFilename));
}

export async function resolveMediaInputUrl({
  mediaType,
  url,
  userId,
}: {
  mediaType: string;
  url: string;
  userId: string;
}) {
  if (url.startsWith("data:")) {
    return url;
  }

  let parsed: URL;
  try {
    parsed = new URL(url, "http://chatbot.local");
  } catch {
    return url;
  }

  const prefix = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/media/files/`;
  if (!parsed.pathname.startsWith(prefix)) {
    return url;
  }

  const filename = decodeURIComponent(parsed.pathname.slice(prefix.length));
  const bytes = await readOwnedMedia(userId, filename);
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

async function ownedMediaFiles(userId: string, kind: "image" | "video") {
  const directory = ownerDirectory(userId);
  const allowedExtensions =
    kind === "video" ? [".mp4", ".webm"] : [".jpg", ".png", ".webp"];
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          allowedExtensions.some((extension) =>
            entry.name.toLowerCase().endsWith(extension)
          )
      )
      .map(async (entry) => ({
        filename: entry.name,
        modifiedAt: (await stat(join(directory, entry.name))).mtimeMs,
      }))
  );
}

export async function latestOwnedMediaFilename(
  userId: string,
  kind: "image" | "video"
) {
  const candidates = await ownedMediaFiles(userId, kind);
  return candidates.sort((a, b) => b.modifiedAt - a.modifiedAt)[0]?.filename;
}

export async function closestOwnedMediaFilename(
  userId: string,
  kind: "image" | "video",
  targetTime: Date
) {
  const candidates = await ownedMediaFiles(userId, kind);
  const target = targetTime.getTime();
  return candidates.sort(
    (a, b) => Math.abs(a.modifiedAt - target) - Math.abs(b.modifiedAt - target)
  )[0]?.filename;
}

export function mediaTypeForFilename(filename: string) {
  if (filename.endsWith(".jpg")) {
    return "image/jpeg";
  }
  if (filename.endsWith(".webp")) {
    return "image/webp";
  }
  if (filename.endsWith(".mp4")) {
    return "video/mp4";
  }
  if (filename.endsWith(".webm")) {
    return "video/webm";
  }
  return "image/png";
}
