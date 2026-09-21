import { readFileSync } from "node:fs";

const catalogPath = process.argv[2];
if (!catalogPath) {
  throw new Error("usage: validate-model-catalog.mjs <catalog.json>");
}

const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
  throw new Error("model catalog root must be an object");
}
const allowedCatalogFields = new Set(["models", "updatedAt"]);
const unexpectedCatalogFields = Object.keys(catalog).filter(
  (field) => !allowedCatalogFields.has(field)
);
if (unexpectedCatalogFields.length > 0) {
  throw new Error("model catalog root contains unexpected fields");
}
if (catalog.updatedAt !== undefined && typeof catalog.updatedAt !== "string") {
  throw new Error("model catalog updatedAt must be a string");
}
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
const stringFields = ["description", "kind", "name", "provider"];
const integerFields = [
  "contextWindowTokens",
  "maxInputTokens",
  "maxOutputTokens",
];
const seenModelIds = new Set();

for (const model of catalog.models) {
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    throw new Error("model catalog contains a non-object entry");
  }
  if (typeof model.id !== "string" || model.id.length === 0) {
    throw new Error("model catalog contains an entry without an id");
  }
  if (seenModelIds.has(model.id)) {
    throw new Error(`model catalog contains a duplicate id: ${model.id}`);
  }
  seenModelIds.add(model.id);
  const unexpected = Object.keys(model).filter(
    (field) => !allowedModelFields.has(field)
  );
  if (unexpected.length > 0) {
    throw new Error(`model catalog has unexpected fields for ${model.id}`);
  }
  for (const field of stringFields) {
    if (model[field] !== undefined && typeof model[field] !== "string") {
      throw new Error(`model ${field} must be a string for ${model.id}`);
    }
  }
  for (const field of integerFields) {
    if (
      model[field] !== undefined &&
      (!Number.isSafeInteger(model[field]) || model[field] < 1)
    ) {
      throw new Error(`model ${field} must be a positive integer for ${model.id}`);
    }
  }
  if (
    model.chatSupported !== undefined &&
    typeof model.chatSupported !== "boolean"
  ) {
    throw new Error(`model chatSupported must be boolean for ${model.id}`);
  }
  if (
    model.kinds !== undefined &&
    (!Array.isArray(model.kinds) ||
      model.kinds.some((kind) => typeof kind !== "string" || kind.length === 0))
  ) {
    throw new Error(`model kinds must be an array of strings for ${model.id}`);
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
    if (
      Object.values(model.capabilities).some(
        (capability) => typeof capability !== "boolean"
      )
    ) {
      throw new Error(`model capabilities must be boolean for ${model.id}`);
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
