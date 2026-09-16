"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useActionState, useEffect, useState } from "react";

import { AuthForm } from "@/components/chat/auth-form";
import { SubmitButton } from "@/components/chat/submit-button";
import { toast } from "@/components/chat/toast";
import { type RegisterActionState, register } from "../actions";

export default function Page() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [isSuccessful, setIsSuccessful] = useState(false);
  const [state, formAction] = useActionState<RegisterActionState, FormData>(
    register,
    { status: "idle" }
  );
  const { update: updateSession } = useSession();
  const error =
    state.status === "user_exists"
      ? "An account with this email already exists."
      : state.status === "failed"
        ? "Unable to create your account. Please try again."
        : state.status === "invalid_data"
          ? "Enter a valid email address and a password of at least 6 characters."
          : undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: router and updateSession are stable refs
  useEffect(() => {
    if (state.status === "success") {
      setIsSuccessful(true);
      updateSession();
      router.replace("/");
    } else if (state.status === "pending_authorization") {
      setIsSuccessful(true);
      toast({
        description:
          "Account registered! You cannot log in until your account is authorized.",
        type: "success",
      });
      router.replace("/login");
    } else if (error) {
      toast({ description: error, type: "error" });
    }
  }, [state.status]);

  const handleSubmit = (formData: FormData) => {
    setEmail(formData.get("email") as string);
    formAction(formData);
  };

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Create account</h1>
      <p className="text-sm text-muted-foreground">
        Create an account to begin.
      </p>
      <AuthForm action={handleSubmit} defaultEmail={email} error={error}>
        <SubmitButton isSuccessful={isSuccessful}>Sign up</SubmitButton>
        <p className="text-center text-[13px] text-muted-foreground">
          {"Have an account? "}
          <Link
            className="text-foreground underline-offset-4 hover:underline"
            href="/login"
          >
            Sign in
          </Link>
        </p>
      </AuthForm>
    </>
  );
}
