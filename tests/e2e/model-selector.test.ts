import { expect, test } from "@playwright/test";

test.describe("Model Selector", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("displays a model button", async ({ page }) => {
    const modelButton = page.getByTestId("model-selector");
    await expect(modelButton).toBeVisible();
  });

  test("opens model selector popover on click", async ({ page }) => {
    const modelButton = page.getByTestId("model-selector");
    await modelButton.click();

    await expect(page.getByPlaceholder("Search models...")).toBeVisible();
  });

  test("can search for models", async ({ page }) => {
    const modelButton = page.getByTestId("model-selector");
    await modelButton.click();

    const searchInput = page.getByPlaceholder("Search models...");
    await searchInput.fill("DeepSeek");

    await expect(
      page.getByRole("option", { name: /DeepSeek V3\.2/ })
    ).toBeVisible();
  });

  test("can close model selector by clicking outside", async ({ page }) => {
    const modelButton = page.getByTestId("model-selector");
    await modelButton.click();

    await expect(page.getByPlaceholder("Search models...")).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(page.getByPlaceholder("Search models...")).not.toBeVisible();
  });

  test("shows available models", async ({ page }) => {
    const modelButton = page.getByTestId("model-selector");
    await modelButton.click();

    const availableModels = page.getByRole("group", { name: "Available" });
    await expect(availableModels).toBeVisible();
    await expect(
      availableModels.getByRole("option", { name: /DeepSeek V3\.2/ })
    ).toBeVisible();
    await expect(
      availableModels.getByRole("option", { name: /Kimi K2\.5/ })
    ).toBeVisible();
  });

  test("can select a different model", async ({ page }) => {
    const modelButton = page.getByTestId("model-selector");
    await modelButton.click();

    await page.getByRole("option", { name: /DeepSeek V3\.2/ }).click();

    await expect(page.getByPlaceholder("Search models...")).not.toBeVisible();
    await expect(modelButton).toContainText("DeepSeek V3.2");
  });

  test("shows the saved model before the first message", async ({
    context,
    page,
  }) => {
    const savedModelId = "nvidia/minimaxai/minimax-m3";
    await context.addCookies([
      {
        domain: "localhost",
        name: "chat-model",
        path: "/",
        value: encodeURIComponent(savedModelId),
      },
    ]);
    await page.route("**/api/models", (route) =>
      route.fulfill({
        body: JSON.stringify({
          capabilities: {
            [savedModelId]: { reasoning: true, tools: true, vision: true },
          },
          models: [
            {
              description: "Saved model regression fixture",
              id: savedModelId,
              name: "Minimax M3",
              provider: "minimax",
            },
          ],
        }),
        contentType: "application/json",
        status: 200,
      })
    );

    await page.goto("/");

    await expect(page.getByTestId("model-selector")).toContainText(
      "Minimax M3"
    );
  });
});
