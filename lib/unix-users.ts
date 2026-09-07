import { readFile } from "node:fs/promises";

const PASSWD_PATH = process.env.PASSWD_PATH ?? "/etc/passwd";
const MIN_UID = 1000;
const MAX_UID = 60_000;
const NON_LOGIN_SHELLS = ["/usr/sbin/nologin", "/sbin/nologin", "/bin/false"];

export type UnixIdentity = {
  name: string;
  uid: number;
};

/**
 * Lists human Unix accounts usable as chat identities. Only the username and uid
 * are read; no other passwd fields are exposed.
 */
export async function listUnixIdentities(): Promise<UnixIdentity[]> {
  try {
    const contents = await readFile(PASSWD_PATH, "utf8");

    return contents
      .split("\n")
      .map((line) => line.split(":"))
      .filter((fields) => fields.length >= 7)
      .map((fields) => ({
        name: fields[0],
        shell: fields[6],
        uid: Number.parseInt(fields[2], 10),
      }))
      .filter(
        (entry) =>
          Number.isInteger(entry.uid) &&
          entry.uid >= MIN_UID &&
          entry.uid < MAX_UID &&
          !NON_LOGIN_SHELLS.includes(entry.shell)
      )
      .map(({ name, uid }) => ({ name, uid }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function isValidUnixIdentity(name: string): Promise<boolean> {
  const identities = await listUnixIdentities();
  return identities.some((identity) => identity.name === name);
}
