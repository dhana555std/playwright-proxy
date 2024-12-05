import { test as baseTest, Page, Locator,TestInfo  } from '@playwright/test';
import fs from 'fs/promises';
import path from 'path';
import lighthouse from 'lighthouse';
import { URL } from 'url';
import AxeBuilder from '@axe-core/playwright';
import { existsSync } from 'fs';
import * as dotenv from 'dotenv';
dotenv.config();
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
          let domAfter;

          const networkData: { requests: Request[]} = { requests: []};
          const onRequest = (request: Request) => networkData.requests.push({
            url: request.url(),
            method: request.method(),
            headers: request.headers(),
          });
          
          
          locator.page().on('request', onRequest);
          
          const result = await (originalMethod as Function).apply(target, args);
          console.log(`After executing ${String(prop)} on locator`);
          
          domAfter = String(prop) !== 'goto' ? await locator.page().content() : '';
                // Remove listeners
          locator.page().off('request', onRequest);

          const isDomChanged = domBefore !== domAfter;
                  
          await runMetrics(locator.page(),testInfo,String(prop),networkData,isDomChanged);
          
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
            // console.log(`[${testInfo.title}] Page action: ${String(prop)}, args:`, args);
            // console.log(`Page action invoked: ${String(prop)} with args:`, args);
            // console.log(`Before executing ${String(prop)}`);
            
            const networkData: { requests: Request[]} = { requests: []};
            const onRequest = (request: Request) => networkData.requests.push({
              url: request.url(),
              method: request.method(),
              headers: request.headers(),
            });
            //const onResponse = (response: Response) => networkData.responses.push(response);

            page.on('request', onRequest);
            const domBefore  = String(prop) !== 'goto' ? page.content() : '';
            let domAfter;
            
            if ( result instanceof Promise) {
              result =  result.then(async (res) => {
                  console.log(`After executing ${String(prop)}`);
                  domAfter = String(prop) !== 'goto' ? await page.content() : '';
                  // Remove listeners
                  page.off('request', onRequest);
                  
                  const isDomChanged = domBefore !== domAfter;
                  
                  await runMetrics(page,testInfo,String(prop),networkData,isDomChanged);
                  return res;
              });
            }  else  {
              const isDomChanged = domBefore !== domAfter;
                  
              runMetrics(page,testInfo,String(prop),networkData,isDomChanged);
                  
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
  page: Page
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
  // Ensure the 'browser_metrics' folder exists
  await ensureMetricsFolder('A11y');
 

  const outputFileName = `A11y_Report_${actionName}_${Date.now()}.json`;
  const networkFileName = `Network_Report_${actionName}_${Date.now()}.json`;

  // Write the files
  await fs.writeFile(`A11y/${outputFileName}`, JSON.stringify(report,null,2));
  console.log(`[${metadata.testTitle}] Accessibility report saved: ${outputFileName}`);
}

async function a11YImagesGenerator(page:Page,accessibilityScanResults:any) {
  // Optionally take screenshots for violations
  await ensureMetricsFolder('A11y_screenshots');
  try {
    for (const violation of accessibilityScanResults.violations) {
        console.log(`Violation: ${violation.id} - ${violation.description}`);
        for (const node of violation?.nodes) {
            const target = node.target.join(',');
            const locator = page.locator(target);
            await locator.screenshot({ path: `A11y_screenshots/axe-${violation.id}.png` });
        }
    }
  }
  catch(err){
    console.log('Error in screenshot capture',err);
  }
}

// Helper function to capture performance metrics and include test info
async function getBrowserPerformanceMetrics(page: Page, testInfo: TestInfo) {
  // Capture window.performance data from the browser
  const performanceData = await page.evaluate(() => {
    return JSON.stringify(window.performance);
  });
  
  // Get the test name and description, with fallback values if not provided
  const testName = testInfo.title || 'Unnamed Test';
  const testDescription = testInfo.description || 'No description provided';

  // Get the test file name and line number
  const testFileName = testInfo.testFile 
  ? path.basename(testInfo.testFile, path.extname(testInfo.testFile))
  : testInfo.titlePath[0] ? testInfo.titlePath[0] : 'test';
  const lineNumber = testInfo.line || 'Unknown Line';

  // Structure the data to include test info
  const testData = {
    testName,
    testDescription,
    testFile:testInfo.titlePath[0] ? testInfo.titlePath[0] : '',
    lineNumber,
    performanceData: JSON.parse(performanceData),
  };

  // Ensure the 'browser_metrics' folder exists
  ensureMetricsFolder('browser_metrics');
  
  // Define the file path for saving the JSON file with the required naming convention
  const filePath = `browser_metrics/${testFileName}_${lineNumber}_browserperformance.json`;

  // Write the performance data to a JSON file
  await fs.writeFile(filePath, JSON.stringify(testData, null, 2));

  return testData; // Return the structured data if needed for further actions
}

// Helper function to create the 'browser_metrics' folder if it doesn't exist
async function ensureMetricsFolder(metricsType: string) {
  if (!existsSync(metricsType)) {
    fs.mkdir(metricsType);
  }
}

async function  captureNetworkcall(networkData:any,testInfo:TestInfo) {
   // Get the test name and description, with fallback values if not provided
   const testName = testInfo.title || 'Unnamed Test';
   const testDescription = testInfo.description || 'No description provided';
 
   // Safely get the test file name, using the current directory as a fallback
   const testFileName = testInfo.testFile 
     ? path.basename(testInfo.testFile, path.extname(testInfo.testFile))
     : testInfo.titlePath[0] ? testInfo.titlePath[0] : 'test';
 
   const lineNumber = testInfo.line || 'Unknown Line';
 
   // Structure the data to include test info
   const testData = {
     testName,
     testDescription,
     testFile: testInfo.titlePath[0] ? testInfo.titlePath[0] : 'test file',
     lineNumber,
     networkData,
   };
 
   // Ensure the 'network_calls' folder exists
   await ensureMetricsFolder('network_calls');
 
   // Define the file path for saving the JSON file with the required naming convention
   const filePath = `network_calls/${testFileName}_${lineNumber}_networkcalls.json`;
 
   // Write the network data to a JSON file
   await fs.writeFile(filePath, JSON.stringify(testData, null, 2));
 
   console.log(`Network call data saved to: ${filePath}`);
}

async function runMetrics(page:Page,testInfo:TestInfo,action:string,networkData:any,isDomChanged:boolean) {
  console.log(process.env.ENABLE_ACCESSIBILITY)
    if(isDomChanged && process.env.ENABLE_NETWORK_LOGS == 'true')
    {
      await captureNetworkcall(networkData,testInfo);
    }  
      
    if(process.env.ENABLE_ACCESSIBILITY  == 'true')
    {
      await checkAccessibilityAndSave(page,testInfo,action,networkData);
    }

    if(process.env.ENABLE_BROWSER_PERFORMANCE  == 'true')
    {
      await getBrowserPerformanceMetrics(page,testInfo);
    }
    
}

export { test };