import { test } from './fixture';
import {expect} from "@playwright/test";

test.describe('Example tests',async()=>{
  test('Generic proxy for expect and page methods', async ({ page }) => {
    // Use the proxied page fixture
    await page.goto('https://example.com');
    // Intercepted page methods
    const locator = page.locator('h1');
    await locator.click();

    // Intercepted expect assertions
    await expect(page).toHaveTitle(/Example Domain/);
    await expect(page).toHaveURL('https://example.com/');
  });
});  
