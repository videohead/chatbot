import type { UserType } from "@/app/(auth)/auth";

type Entitlements = {
  maxMessagesPerHour: number;
};

// Self-hosted single-tenant deployment; throttling exists only as a runaway guard.
const MAX_MESSAGES_PER_HOUR = Number.parseInt(
  process.env.MAX_MESSAGES_PER_HOUR ?? "1000000",
  10
);

export const entitlementsByUserType: Record<UserType, Entitlements> = {
  regular: {
    maxMessagesPerHour: MAX_MESSAGES_PER_HOUR,
  },
};
