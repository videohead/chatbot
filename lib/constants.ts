import { generateDummyPassword } from "./db/utils";

export const isProductionEnvironment = process.env.NODE_ENV === "production";
export const isDevelopmentEnvironment = process.env.NODE_ENV === "development";
export const isTestEnvironment = Boolean(
  process.env.PLAYWRIGHT_TEST_BASE_URL ||
    process.env.PLAYWRIGHT ||
    process.env.CI_PLAYWRIGHT
);

export const guestRegex = /^guest-\d+$/;

export const DUMMY_PASSWORD = generateDummyPassword();

export const suggestions = [
  "List the MCP tools available through the metis-router gateway",
  "Diagnose the openharness-chat service and summarize recent errors",
  "Compare the architecture of WorldGraph Studio and Morphazoid",
  "Create a ComfyUI text-to-video workflow for a short scene",
];
