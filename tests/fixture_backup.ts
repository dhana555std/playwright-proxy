import { test as baseTest, Page, Locator,TestInfo  } from '@playwright/test';
import fs from 'fs/promises';
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
          
          await checkAccessibilityAndSave(locator.page());
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
                await checkAccessibilityAndSave(page);
                return res;
              });
            } else {
              console.log(`After executing ${String(prop)}`);
                checkAccessibilityAndSave(page);
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


// Function to check for accessibility issues and save as JSON
async function checkAccessibilityAndSave(page) { 
    // Use AxeBuilder to scan the page for accessibility violations
    const accessibilityScanResults = await new AxeBuilder({ page })
        .analyze();
  
    // Log the entire accessibilityScanResults to debug
    // console.log('Accessibility Scan Results:', accessibilityScanResults);
  
    // Ensure violations is an array
    const violations = accessibilityScanResults.violations || [];
  
    if (violations.length === 0) {
        console.log('No accessibility violations found.');
    } else {
        // Map the results to include necessary details
        const mappedViolations = violations.map(violation => {
            return {
                issue: violation.description,  
                help: violation.help,  
                helpUrl: violation.helpUrl,  
                impact: violation.impact,  
                wcagTags: violation.tags,  
                nodes: violation.nodes.map(node => ({
                    target: node.target.join(', '),  
                    failureSummary: node.failureSummary,  
                    html: node.html  
                }))
            };
        });
  
        // // Safely access titlePath and provide default values if undefined
        // const scenario = testInfo.titlePath[1]; 
        // const step = testInfo.titlePath[2]
  
        // // Create the final result in the requested format
        // const result = {
        //     task: testInfo.title, 
        //     scenarios: [
        //         {
        //             scenarioName: scenario,  
        //             steps: [
        //                 {
        //                     stepName: step,  
        //                     actions: [
        //                         {
        //                             action: actionName,  
        //                             violations: mappedViolations 
        //                         }
        //                     ]
        //                 }
        //             ]
        //         }
        //     ]
        // };
  
        // // Log the number of violations found
        // console.log(`Found ${violations.length} accessibility violations`);
  
        // Create a filename based on the action name
        // const outputFileName = `${actionName.replace(/\s+/g, '_')}-accessibility-violations.json`;
      
        // Save the result to a JSON file
        await fs.writeFile(`A11y/Reports_${Date.now()}.json`, JSON.stringify(mappedViolations, null, 2));
        console.log(`Accessibility violations saved to 'reports.json'`);
    }
  }


export { test };


