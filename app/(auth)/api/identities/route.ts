import { NextResponse } from "next/server";

import { listUnixIdentities } from "@/lib/unix-users";

export async function GET() {
  return NextResponse.json({ identities: await listUnixIdentities() });
}
