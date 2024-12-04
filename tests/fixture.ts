import { test as baseTest, Page, Locator,TestInfo  } from '@playwright/test';
import fs from 'fs/promises';
import lighthouse from 'lighthouse';
import { URL } from 'url';
import AxeBuilder from '@axe-core/playwright';
 // List of allowed methods for page
const allowedPageMethods = [
  'click',
  'close',
  'dblclick',
  'dispatchEvent',
  'dragAndDrop',
  'emulateMedia',
  'fill',
  'focus',
  'goBack',
  'goForward',
  'goto',
  'hover',
  'press',
  'reload',
  'selectOption',
  'tap',
  'touchScreen',
  'uncheck',
  'blur',
  'check',
  'keyboard',
  'mouse',
];

// List of allowed methods for locator
const allowedLocatorMethods = [
  'check',
  'clear',
  'click',
  'dblclick',
  'dispatchEvent',
  'dragTo',
  'fill',
  'focus',
  'highlight',
  'hover',
  'press',
  'pressSequentially',
  'scrollIntoViewIfNeeded',
  'selectOption',
  'selectText',
  'setChecked',
  'setInputFiles',
  'tap',
  'uncheck',
];

// Utility function to wrap locator actions
function wrapLocatorActions(locator: Locator,testInfo: TestInfo): Locator {
  return new Proxy(locator, {
    get(target, prop) {
      if (!allowedLocatorMethods.includes(String(prop))) {
        return target[prop as keyof Locator];
      }

      const originalMethod = target[prop as keyof Locator];
      if (typeof originalMethod === 'function') {
        return async (...args: any[]) => {
          console.log(`[${testInfo.title}] Locator action: ${String(prop)}, args:`, args);
          console.log(`Locator action invoked: ${String(prop)} with args:`, args);
          console.log(`Before executing ${String(prop)} on locator`);
          const domBefore  = String(prop) !== 'goto' ? locator.page().content() : '';  
          const networkData: { requests: Request[]; responses: Response[] } = { requests: [], responses: [] };
          const onRequest = (request: Request) => networkData.requests.push(request);
          const onResponse = (response: Response) => networkData.responses.push(response);

          locator.page().on('request', onRequest);
          locator.page().on('response', onResponse);

          const result = await (originalMethod as Function).apply(target, args);
          console.log(`After executing ${String(prop)} on locator`);
          
          const domAfter = String(prop) !== 'goto' ? await locator.page().content() : '';
                // Remove listeners
            locator.page().off('request', onRequest);
            locator.page().off('response', onResponse);

            // Compare DOM states
            console.log(
                domBefore === domAfter
                ? `DOM state unchanged for ${String(prop)}`
                : `DOM state changed for ${String(prop)}`
            );

            // Log network activity
            console.log(`Network activity for ${String(prop)}:`, networkData.requests.length,networkData.responses.length);   
          
          await checkAccessibilityAndSave(locator.page(),testInfo,String(prop),networkData);
          // await runLighthouseAudit(locator.page(), testInfo, String(prop));
          return result;
        };
      }
      return originalMethod;
    },
  });
}

// Utility function to wrap page actions
function wrapPageActions(page: Page,testInfo: TestInfo): Page {
  return new Proxy(page, {
    get(target, prop) {
      const originalMethod = target[prop as keyof Page];

      if (typeof originalMethod === 'function') {
        return (...args: any[]) => {
          let result = (originalMethod as Function).apply(target, args);

          // If the method is in allowedPageMethods, add logging
          if (allowedPageMethods.includes(String(prop))) {
            console.log(`[${testInfo.title}] Page action: ${String(prop)}, args:`, args);
            console.log(`Page action invoked: ${String(prop)} with args:`, args);
            console.log(`Before executing ${String(prop)}`);
            
            const networkData: { requests: Request[]; responses: Response[] } = { requests: [], responses: [] };
            const onRequest = (request: Request) => networkData.requests.push(request);
            const onResponse = (response: Response) => networkData.responses.push(response);

            page.on('request', onRequest);
            page.on('response', onResponse);
            
            // Capture DOM state before the action
            
            const domBefore  = String(prop) !== 'goto' ? page.content() : '';
            
            
            if ( result instanceof Promise) {
              result =  result.then(async (res) => {
                console.log(`After executing ${String(prop)}`);
                const domAfter = String(prop) !== 'goto' ? await page.content() : '';
                // Remove listeners
                page.off('request', onRequest);
                page.off('response', onResponse);

                // Compare DOM states
                console.log(
                    domBefore === domAfter
                      ? `DOM state unchanged for ${String(prop)}`
                      : `DOM state changed for ${String(prop)}`
                  );
                  

                // Log network activity
                console.log(`Network activity for ${String(prop)}:`, networkData.requests.length,networkData.responses.length);    
                await checkAccessibilityAndSave(page,testInfo,String(prop),networkData);
                // await runLighthouseAudit(page, testInfo, String(prop));
                return res;
              });
            }  else  {
              console.log(`After executing ${String(prop)}`);
                  checkAccessibilityAndSave(page,testInfo,String(prop),networkData);
                // runLighthouseAudit(page, testInfo, String(prop));
            }
          }

          // Wrap any Locator returned, regardless of the method
          if (result instanceof Promise) {
            return result.then(async(res) => await wrapLocatorIfNeeded(res,testInfo));
          } else {
            return  wrapLocatorIfNeeded(result,testInfo);
          }
        };
      }
      return originalMethod;
    },
  });
}

// Helper function to wrap Locator if needed
function wrapLocatorIfNeeded(obj: any,testInfo:TestInfo): any {
  if (obj && obj.constructor && obj.constructor.name === 'Locator') {
    return wrapLocatorActions(obj,testInfo);
  }
  return obj;
}

// Extend the base test to include the wrapped page fixture
 const test = baseTest.extend<{
  page: Page;
}>({
  page: async ({ page }, use,testInfo) => {
    const wrappedPage = wrapPageActions(page,testInfo);
    await use(wrappedPage);
  },
});



async function checkAccessibilityAndSave(page: Page, testInfo: TestInfo, actionName: string, networkData: any) {
  const accessibilityScanResults = await new AxeBuilder({ page }).analyze();

  // Process violations to remove potential circular references
  const violations = accessibilityScanResults.violations?.map((violation) => ({
    issue: violation.description,
    help: violation.help,
    helpUrl: violation.helpUrl,
    impact: violation.impact,
    wcagTags: violation.tags,
    nodes: violation.nodes.map((node) => ({
      target: node.target.join(', '),
      failureSummary: node.failureSummary,
      html: node.html,
    })),
  })) || [];

  
  const metadata = {
    testTitle: testInfo?.title,
    describeBlock: testInfo?.titlePath?.slice(0, -1).join(' > ') || "No describe block",
    actionName,
    timestamp: new Date().toISOString(),
  };

  const report = {
    metadata,
    violations,
  };

  await a11YImagesGenerator(page,accessibilityScanResults);

  const outputFileName = `A11y_Report_${actionName}_${Date.now()}.json`;
  const networkFileName = `Network_Report_${actionName}_${Date.now()}.json`;

  // Write the files
  await fs.writeFile(`A11y/${outputFileName}`, JSON.stringify(report,null,2));
  await fs.writeFile(`A11y/${networkFileName}`, JSON.stringify(networkData, null, 2));

  console.log(`[${metadata.testTitle}] Accessibility report saved: ${outputFileName}`);
}

async function a11YImagesGenerator(page:Page,accessibilityScanResults:any) {
  // Optionally take screenshots for violations
  for (const violation of accessibilityScanResults.violations) {
      console.log(`Violation: ${violation.id} - ${violation.description}`);
      for (const node of violation?.nodes) {
          const target = node.target.join(',');
          const locator = page.locator(target);
          await locator.screenshot({ path: `screenshots/axe-${violation.id}.png` });
      }
  }
}

export { test };