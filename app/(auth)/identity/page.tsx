import { Suspense } from "react";

import { listUnixIdentities } from "@/lib/unix-users";
import { selectIdentity } from "./actions";

async function IdentityList() {
  const identities = await listUnixIdentities();

  if (identities.length === 0) {
    return (
      <p className="mt-6 text-muted-foreground text-sm">
        No identities available.
      </p>
    );
  }

  return (
    <ul className="mt-6 flex flex-col gap-2">
      {identities.map((identity) => (
        <li key={identity.uid}>
          <form action={selectIdentity}>
            <input name="username" type="hidden" value={identity.name} />
            <button
              className="w-full rounded-lg border px-4 py-3 text-left text-sm transition-colors hover:bg-muted"
              type="submit"
            >
              <span className="font-medium">{identity.name}</span>
              <span className="ml-2 text-muted-foreground text-xs">
                uid {identity.uid}
              </span>
            </button>
          </form>
        </li>
      ))}
    </ul>
  );
}

export default function IdentityPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <div className="w-full max-w-md rounded-2xl border p-8">
        <h1 className="font-semibold text-2xl">Choose an identity</h1>
        <p className="mt-2 text-muted-foreground text-sm">
          Used only to scope your chat history. This is not authentication.
        </p>

        <Suspense
          fallback={
            <p className="mt-6 text-muted-foreground text-sm">Loading…</p>
          }
        >
          <IdentityList />
        </Suspense>
      </div>
    </div>
  );
}
