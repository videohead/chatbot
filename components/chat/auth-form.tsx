import Form from "next/form";

import { Input } from "../ui/input";
import { Label } from "../ui/label";

export function AuthForm({
  action,
  children,
  defaultEmail = "",
  error,
}: {
  action: NonNullable<
    string | ((formData: FormData) => void | Promise<void>) | undefined
  >;
  children: React.ReactNode;
  defaultEmail?: string;
  error?: string;
}) {
  return (
    <Form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label className="font-normal text-muted-foreground" htmlFor="email">
          Email
        </Label>
        <Input
          autoComplete="email"
          autoFocus
          className="h-10 rounded-lg border-border/50 bg-muted/50 text-sm transition-colors focus:border-foreground/20 focus:bg-muted"
          defaultValue={defaultEmail}
          id="email"
          name="email"
          placeholder="you@someo.ne"
          required
          type="email"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label className="font-normal text-muted-foreground" htmlFor="password">
          Password
        </Label>
        <Input
          className="h-10 rounded-lg border-border/50 bg-muted/50 text-sm transition-colors focus:border-foreground/20 focus:bg-muted"
          id="password"
          name="password"
          placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;"
          required
          type="password"
        />
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      {children}
    </Form>
  );
}
