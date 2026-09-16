import { expect, test } from "@playwright/test";

test.describe("Authentication Pages", () => {
  test("login page renders correctly", async ({ page }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: "Welcome back" })
    ).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("registration page renders correctly", async ({ page }) => {
    await page.goto("/register");
    await expect(
      page.getByRole("heading", { name: "Create account" })
    ).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign up" })).toBeVisible();
  });

  test("registration creates an account and redirects to login when unauthorized", async ({
    page,
  }) => {
    await page.goto("/register");
    await page.getByLabel("Email").fill(`test-${Date.now()}@example.com`);
    await page.getByLabel("Password").fill("password-for-e2e-test");
    await page.getByRole("button", { name: "Sign up" }).click();
    await page.waitForURL("/login");
  });
});
