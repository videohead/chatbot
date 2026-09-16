// Static, environment-configured auth users.
//
// The chatbot does not allow self-service registration. Users are forced to
// authenticate with one of the accounts configured via the CHATBOT_AUTH_USERS
// environment variable (a JSON array of { email, passwordHash }).

export type StaticAuthUser = {
  email: string;
  passwordHash: string;
};

function loadStaticAuthUsers(): StaticAuthUser[] {
  try {
    const configuredUsers = JSON.parse(
      process.env.CHATBOT_AUTH_USERS ?? "[]"
    ) as unknown;

    if (!Array.isArray(configuredUsers)) {
      return [];
    }

    return configuredUsers.flatMap((configuredUser) => {
      if (
        typeof configuredUser !== "object" ||
        configuredUser === null ||
        typeof (configuredUser as StaticAuthUser).email !== "string" ||
        typeof (configuredUser as StaticAuthUser).passwordHash !== "string"
      ) {
        return [];
      }

      return [
        {
          email: (configuredUser as StaticAuthUser).email.trim().toLowerCase(),
          passwordHash: (configuredUser as StaticAuthUser).passwordHash,
        },
      ];
    });
  } catch {
    return [];
  }
}

export const staticAuthUsers = loadStaticAuthUsers();

export function getStaticAuthUser(email: string): StaticAuthUser | undefined {
  const normalizedEmail = email.trim().toLowerCase();
  return staticAuthUsers.find((user) => user.email === normalizedEmail);
}
