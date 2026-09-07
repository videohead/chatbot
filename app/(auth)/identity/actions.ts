"use server";

import { signIn } from "@/app/(auth)/auth";
import { isValidUnixIdentity } from "@/lib/unix-users";

export async function selectIdentity(formData: FormData) {
  const username = String(formData.get("username") ?? "");

  if (!(await isValidUnixIdentity(username))) {
    return;
  }

  await signIn("unix", {
    redirect: true,
    redirectTo: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/`,
    username,
  });
}
