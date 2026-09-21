import { readFileSync } from "node:fs";

const catalogPath = process.argv[2];
if (!catalogPath) {
  throw new Error("usage: validate-model-catalog.mjs <catalog.json>");
}

const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
  throw new Error("model catalog is absent or empty");
}

const allowedModelFields = new Set([
  "capabilities",
  "chatSupported",
  "contextWindowTokens",
  "description",
  "id",
  "kind",
  "kinds",
  "maxInputTokens",
  "maxOutputTokens",
  "name",
  "provider",
]);
const allowedCapabilityFields = new Set(["reasoning", "tools", "vision"]);

for (const model of catalog.models) {
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    throw new Error("model catalog contains a non-object entry");
  }
  if (typeof model.id !== "string" || model.id.length === 0) {
    throw new Error("model catalog contains an entry without an id");
  }
  const unexpected = Object.keys(model).filter(
    (field) => !allowedModelFields.has(field)
  );
  if (unexpected.length > 0) {
    throw new Error(`model catalog has unexpected fields for ${model.id}`);
  }
  if (model.capabilities !== undefined) {
    if (
      !model.capabilities ||
      typeof model.capabilities !== "object" ||
      Array.isArray(model.capabilities)
    ) {
      throw new Error(`model capabilities are invalid for ${model.id}`);
    }
    const unexpectedCapabilities = Object.keys(model.capabilities).filter(
      (field) => !allowedCapabilityFields.has(field)
    );
    if (unexpectedCapabilities.length > 0) {
      throw new Error(`model capabilities have unexpected fields for ${model.id}`);
    }
  }
}

const rawCatalog = JSON.stringify(catalog);
const secretPatterns = [
  /gh[pousr]_[A-Za-z0-9_]{30,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /glpat-[A-Za-z0-9_-]{20,}/,
  /(?:nvapi-|ihub_api)[A-Za-z0-9_-]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
if (secretPatterns.some((pattern) => pattern.test(rawCatalog))) {
  throw new Error("model catalog contains a credential-shaped value");
}

console.log(`Validated metadata-only catalog with ${catalog.models.length} models.`);
