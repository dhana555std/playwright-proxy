import { test } from './fixture';


test.describe('katlon',async()=>{

    test('Monitor DOM changes during login test', async ({ page }) => {
        // Navigate to the login page
        await page.goto('https://katalon-demo-cura.herokuapp.com/profile.php#login');
        // Perform DOM operations
        await page.fill('input[name="username"]', 'John Doe');
        await page.fill('input[name="password"]', 'ThisIsNotAPassword');
        await page.click('button[id="btn-login"]');
        await page.waitForTimeout(5000);
    });
});