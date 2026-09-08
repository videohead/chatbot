export type StaticAuthUser = {
  email: string;
  passwordHash: string;
};

function loadStaticAuthUsers(): StaticAuthUser[] {
  try {
    const configuredUsers = JSON.parse(
      process.env.OPENHARNESS_AUTH_USERS ?? "[]"
    ) as unknown;

    if (!Array.isArray(configuredUsers)) {
      return [];
    }

    return configuredUsers.flatMap((configuredUser) => {
      if (
        typeof configuredUser !== "object" ||
        configuredUser === null ||
        typeof configuredUser.email !== "string" ||
        typeof configuredUser.passwordHash !== "string"
      ) {
        return [];
      }

      return [
        {
          email: configuredUser.email.trim().toLowerCase(),
          passwordHash: configuredUser.passwordHash,
        },
      ];
    });
  } catch {
    return [];
  }
}

export const staticAuthUsers = loadStaticAuthUsers();

export function getStaticAuthUser(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  return staticAuthUsers.find((user) => user.email === normalizedEmail);
}
