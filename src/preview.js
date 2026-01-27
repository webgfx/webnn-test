
const { expect } = require('@playwright/test');
const { WebNNRunner } = require('./util');
const path = require('path');

class PreviewRunner extends WebNNRunner {
  async runPreviewTests() {
    console.log('[Info] Running PREVIEW suite...');

    // Get specific test cases from suite-specific environment variable
    const testCaseFilter = process.env.PREVIEW_CASE;
    let testCases = [];

    if (testCaseFilter) {
      testCases = testCaseFilter.split(',').map(c => c.trim()).filter(c => c.length > 0);
      console.log(`Running specific preview test cases: ${testCases.join(', ')}`);
    } else {
      // Default: run all preview test cases
      testCases = ['ic', 'sdxl', 'phi', 'sam', 'whisper'];
      console.log('Running all preview test cases');
    }

    const results = [];

    for (let i = 0; i < testCases.length; i++) {
      const testCase = testCases[i];
      const initialResultsLength = results.length;
      let infinityErrorDetected = false;
      try {
        await this.runTestWithSessionCheck(async () => {
          const consoleListener = async (msg) => {
            if (msg.text().includes('Found infinity in logits')) {
              console.error(`[Fail] [Auto-Fail] "Found infinity in logits" detected. Quitting case...`);
              infinityErrorDetected = true;
              try { await this.page.close(); } catch (e) {}
            }
          };
          this.page.on('console', consoleListener);

          try {
            switch (testCase) {
              case 'ic':
                await this.runPreviewImageClassification(results);
                break;
              case 'sdxl':
                await this.runPreviewSdxl(results);
                break;
              case 'phi':
                await this.runPreviewPhi(results);
                break;
              case 'sam':
                await this.runPreviewSam(results);
                break;
              case 'whisper':
                await this.runPreviewWhisper(results);
                break;
              default:
                console.log(`[Warning] Unknown preview test case: ${testCase}`);
                results.push({
                  testName: `Preview: ${testCase}`,
                  testUrl: '',
                  result: 'ERROR',
                  errors: [{ text: `Unknown test case: ${testCase}`, selector: 'exception' }],
                  fullText: `Unknown test case: ${testCase}`,
                  hasErrors: true,
                  details: `Unknown test case: ${testCase}`,
                  consoleErrors: [],
                  pageErrors: [],
                  subcases: { total: 1, passed: 0, failed: 1, details: [] },
                  suite: 'preview'
                });
            }
          } finally {
            if (!this.page.isClosed()) {
              this.page.off('console', consoleListener);
            }
          }
        }, i < testCases.length - 1);
      } catch (error) {
        if (infinityErrorDetected) {
          error.message = "Found infinity in logits";
        }
        if (results.length > initialResultsLength) {
          if (error.message.includes('Failed to create session')) {
             console.log(`[Info] Updating result for ${testCase} to reflect session failure.`);
             const lastResult = results[results.length - 1];
             lastResult.result = 'FAIL';
             lastResult.fullText = error.message;
             lastResult.errors = [{ text: error.message, selector: 'exception' }];
             // lastResult.details = error.message; // Don't duplicate message in details
             if (lastResult.subcases) {
                lastResult.subcases.passed = 0;
                lastResult.subcases.failed = 1;
                lastResult.subcases.details = [{ name: error.message, status: 'FAIL' }];
             }
          } else {
             console.log(`[Info] Test case ${testCase} threw error "${error.message}" but result was already recorded.`);
          }
        } else {
          console.error(`[Fail] Error running preview test case ${testCase}:`, error.message);
          results.push({
            testName: `Preview: ${testCase}`,
            testUrl: '',
            result: 'ERROR',
            errors: [{ text: error.message, selector: 'exception' }],
            fullText: error.message,
            hasErrors: true,
            details: error.stack,
            consoleErrors: [],
            pageErrors: [],
            subcases: { total: 1, passed: 0, failed: 1, details: [] },
            suite: 'preview'
          });
        }
      }

      // Pause for 5 seconds before closing tab/moving to next test
      if (!this.page.isClosed()) {
        console.log('Pausing for 5 seconds...');
        await this.page.waitForTimeout(5000);
      }
    }

    console.log('[Success] Completed preview test execution');
    console.log(`Total preview tests executed: ${results.length}`);

    return results;
  }

  async runPreviewImageClassification(results) {
    const testName = 'WebNN Developer Preview Image Classification';
    const startTime = Date.now();

    try {
      console.log(`Running preview test: ${testName}`);

      // Navigate to the preview demo page
      await this.page.goto('https://microsoft.github.io/webnn-developer-preview/demos/image-classification');
      await this.page.waitForLoadState('networkidle');
      console.log('[Success] Navigated to WebNN Developer Preview Image Classification demo');

      await this.page.waitForTimeout(3000);

      // Look for and click the "Classify" button
      console.log('Looking for Classify button...');

      const classifySelectors = [
        'button:has-text("Classify")',
        'input[value="Classify"]',
        '#classify',
        '.classify-btn',
        'button[onclick*="classify"]',
        'button:text("Classify")',
        '[type="button"]:has-text("Classify")'
      ];

      let classifyButton = null;
      for (const selector of classifySelectors) {
        try {
          classifyButton = await this.page.locator(selector).first();
          if (await classifyButton.isVisible()) {
            console.log(`[Success] Found Classify button with selector: ${selector}`);
            break;
          }
        } catch (error) {
          console.log(`Selector "${selector}" not found, trying next...`);
        }
      }

      if (!classifyButton || !(await classifyButton.isVisible())) {
        throw new Error('Could not find Classify button');
      }

      await classifyButton.click();
      console.log('[Success] Clicked Classify button');

      console.log('Starting to check for latency element after clicking Classify...');

      let latencyFound = false;
      let latencyValue = null;
      let checkCount = 0;
      const maxChecks = 120; // 120 checks over 60 seconds
      const checkInterval = 500; // Check every 500ms

      while (checkCount < maxChecks && !latencyFound) {
        checkCount++;
        const latencyResult = await this.page.evaluate(() => {
          const latencyElement = document.querySelector('#latency');
          if (latencyElement) {
            const text = latencyElement.textContent || latencyElement.innerText;
            if (text && text.trim()) {
              return { found: true, content: text.trim() };
            }
          }
          return { found: false, content: null };
        });

        if (latencyResult.found) {
           const content = latencyResult.content.trim();
           const numericMatch = content.match(/(\d+(?:\.\d+)?)/);
           if (numericMatch) {
              const numericValue = parseFloat(numericMatch[1]);
              if (numericValue > 0) {
                 latencyValue = content;
                 latencyFound = true;
                 break;
              }
           }
        }
        await this.page.waitForTimeout(checkInterval);
      }

      if (!latencyFound) throw new Error(`latency element not found after ${maxChecks} attempts`);

      if (!latencyValue.includes('ms')) {
        latencyValue += ' ms';
      }

      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`[Pass] Test PASSED: latency element found with value: ${latencyValue}`);
      results.push({
        testName: testName,
        testUrl: 'https://microsoft.github.io/webnn-developer-preview/demos/image-classification',
        result: 'PASS',
        executionTime: executionTime,
        errors: [],
        fullText: '',
        hasErrors: false,
        details: `Latency: ${latencyValue}`,
        consoleErrors: [],
        pageErrors: [],
        subcases: { total: 1, passed: 1, failed: 0, details: [{ name: `Latency: ${latencyValue}`, status: 'PASS' }] },
        suite: 'preview'
      });

    } catch (error) {
      console.error(`[Fail] Preview test failed: ${error.message}`);
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
      results.push({
        testName: testName,
        testUrl: 'https://microsoft.github.io/webnn-developer-preview/demos/image-classification',
        result: 'FAIL',
        executionTime: executionTime,
        errors: [{ text: error.message, selector: 'exception' }],
        fullText: error.message,
        hasErrors: true,
        // details: error.message,
        consoleErrors: [],
        pageErrors: [],
        subcases: { total: 1, passed: 0, failed: 1, details: [{ name: error.message, status: 'FAIL' }] },
        suite: 'preview'
      });
    }
  }

  async runPreviewSdxl(results) {
    const testName = 'WebNN Developer Preview SDXL Turbo';
    const startTime = Date.now();
    console.log(`Running preview test: ${testName}`);

    try {
      await this.page.goto('https://microsoft.github.io/webnn-developer-preview/demos/sdxl-turbo/');
      await this.page.waitForLoadState('domcontentloaded');
      console.log('[Success] Navigated to SDXL Turbo demo');

      // Click "Load Models"
      const loadButton = this.page.locator('button', { hasText: 'Load Models' });
      await loadButton.waitFor({ state: 'visible', timeout: 30000 });
      await loadButton.click();
      console.log('[Success] Clicked Load Models (Loading models...)');

      // Wait for "Generate Image" button
      // Note: This download is large (several GBs), setting a long timeout
      const generateButton = this.page.locator('button', { hasText: 'Generate Image' });

      console.log('Waiting for "Generate Image" button to be ready...');
      await generateButton.waitFor({ state: 'visible', timeout: 600000 }); // 10 minutes
      await expect(generateButton).toBeEnabled({ timeout: 600000 });

      console.log('[Success] Models loaded. Clicking Generate Image...');
      await generateButton.click();

      // Get XPath result
      const resultLocator = this.page.locator('xpath=//*[@id="total_data"]');
      await resultLocator.waitFor({ state: 'visible', timeout: 120000 });

      // Wait for meaningful text content (not "..." and contains digits)
      let resultText = '';
      let checkCount = 0;
      const maxChecks = 1200; // 10 minutes (checking every 500ms)

      console.log('Waiting for valid result text in #total_data...');
      while (checkCount < maxChecks) {
          const text = await resultLocator.textContent();
          resultText = text ? text.trim() : '';

          if (resultText && resultText !== '...' && /\d/.test(resultText)) {
              console.log(`[Success] Got valid result: ${resultText}`);
              break;
          }
          await this.page.waitForTimeout(500);
          checkCount++;
      }

      if (!resultText || resultText === '...' || !/\d/.test(resultText)) {
          throw new Error(`Timeout waiting for result in #total_data. Last value: "${resultText}"`);
      }

      // Ensure result has unit
      if (!resultText.toLowerCase().includes('ms')) {
          resultText += ' ms';
      }

      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`[Pass] Test PASSED: Got result: ${resultText}`);
      results.push({
        testName: testName,
        testUrl: this.page.url(),
        result: 'PASS',
        executionTime: executionTime,
        details: `Result: ${resultText}`,
        subcases: { total: 1, passed: 1, failed: 0, details: [{ name: resultText, status: 'PASS' }] },
        suite: 'preview'
      });

    } catch (error) {
       console.error(`[Fail] SDXL test failed: ${error.message}`);
       const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
       results.push({
        testName: testName,
        testUrl: this.page.url(),
        result: 'FAIL',
        executionTime: executionTime,
        errors: [{ text: error.message, selector: 'exception' }],
        fullText: error.message,
        hasErrors: true,
        // details: error.message,
        consoleErrors: [],
        pageErrors: [],
        subcases: { total: 1, passed: 0, failed: 1, details: [{ name: error.message, status: 'FAIL' }] },
        suite: 'preview'
      });
    }
  }

  async runPreviewPhi(results) {
    const testName = 'WebNN Developer Preview Phi';
    const startTime = Date.now();
    console.log(`Running preview test: ${testName}`);

    try {
      await this.page.goto('https://microsoft.github.io/webnn-developer-preview/demos/text-generation');
      await this.page.waitForLoadState('domcontentloaded');
      console.log('[Success] Navigated to Text Generation demo');

      // Wait for send button to be ready (implies model loaded or UI ready)
      const sendButton = this.page.locator('xpath=//*[@id="send-button"]');
      console.log('Waiting for Send button to be ready (this may include model load time)...');
      await sendButton.waitFor({ state: 'visible', timeout: 600000 }); // 10 mins
      await expect(sendButton).toBeEnabled({ timeout: 600000 });

      // Input text
      const input = this.page.locator('xpath=//*[@id="user-input"]');
      await input.waitFor({ state: 'visible' });
      await input.fill('tell me a story with 100 words in English');
      console.log('[Success] Input text filled');

      // Click send
      await sendButton.click();
      console.log('[Success] Clicked Send button');

      // Wait for generation to complete (Send button usually becomes disabled then enabled)
      console.log('Waiting for generation to complete...');
      await this.page.waitForTimeout(2000); // Wait for UI to update state
      await expect(sendButton).toBeEnabled({ timeout: 600000 }); // 10 mins for generation
      console.log('[Success] Generation completed');

      // Grab results
      const ttftLocator = this.page.locator('xpath=//*[@id="performance-indicator"]/div[1]/div[2]');
      const tpsLocator = this.page.locator('xpath=//*[@id="performance-indicator"]/div[2]/div[1]');

      let ttft = (await ttftLocator.textContent()).trim();
      const tps = (await tpsLocator.textContent()).trim();

      if (!ttft.toLowerCase().includes('ms')) {
        ttft += ' ms';
      }

      const resultText = `TTFT: ${ttft}, Tokens/s: ${tps}`;
      console.log(`[Pass] Test PASSED: Got result: ${resultText}`);

      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
      results.push({
        testName: testName,
        testUrl: this.page.url(),
        result: 'PASS',
        executionTime: executionTime,
        details: resultText,
        subcases: { total: 1, passed: 1, failed: 0, details: [{ name: resultText, status: 'PASS' }] },
        suite: 'preview'
      });

    } catch (error) {
       console.error(`[Fail] Phi test failed: ${error.message}`);
       const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
       results.push({
        testName: testName,
        testUrl: this.page.url(),
        result: 'FAIL',
        executionTime: executionTime,
        errors: [{ text: error.message, selector: 'exception' }],
        fullText: error.message,
        hasErrors: true,
        // details: error.message,
        consoleErrors: [],
        pageErrors: [],
        subcases: { total: 1, passed: 0, failed: 1, details: [{ name: error.message, status: 'FAIL' }] },
        suite: 'preview'
      });
    }
  }

  async runPreviewSam(results) {
    const testName = 'WebNN Developer Preview Segment Anything';
    const startTime = Date.now();
    console.log(`Running preview test: ${testName}`);

    try {
      await this.page.goto('https://microsoft.github.io/webnn-developer-preview/demos/segment-anything/');
      await this.page.waitForLoadState('domcontentloaded');
      console.log('[Success] Navigated to Segment Anything demo');

      const canvasLocator = this.page.locator('xpath=//*[@id="img_canvas"]');
      const latencyLocator = this.page.locator('xpath=//*[@id="decoder_latency"]');

      console.log('Waiting for canvas element...');
      await canvasLocator.waitFor({ state: 'visible', timeout: 600000 });

      let latencyText = '';
      let resultFound = false;
      const timeout = 600000; // 10 minutes
      const endWait = Date.now() + timeout;

      console.log('Waiting for valid latency result (will hover canvas repeatedly)...');

      while (Date.now() < endWait) {
        try {
            await canvasLocator.hover({ timeout: 5000 });
        } catch (e) {
            // Ignore hover errors
        }

        const text = await latencyLocator.textContent();
        if (text) {
             const trimmed = text.trim();
             if (trimmed && /\d/.test(trimmed)) {
                 latencyText = trimmed;
                 resultFound = true;
                 break;
             }
        }

        await this.page.waitForTimeout(1000);
      }

      if (!resultFound) {
         throw new Error(`Timeout waiting for valid latency in #decoder_latency`);
      }

      if (!latencyText.toLowerCase().includes('ms')) {
        latencyText += ' ms';
      }

      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);

      console.log(`[Pass] Test PASSED: Segment Anything latency: ${latencyText}`);
      results.push({
        testName: testName,
        testUrl: this.page.url(),
        result: 'PASS',
        executionTime: executionTime,
        details: `Latency: ${latencyText}`,
        subcases: { total: 1, passed: 1, failed: 0, details: [{ name: `Latency: ${latencyText}`, status: 'PASS' }] },
        suite: 'preview'
      });

    } catch (error) {
       console.error(`[Fail] SAM test failed: ${error.message}`);
       const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
       results.push({
        testName: testName,
        testUrl: this.page.url(),
        result: 'FAIL',
        executionTime: executionTime,
        errors: [{ text: error.message, selector: 'exception' }],
        fullText: error.message,
        hasErrors: true,
        consoleErrors: [],
        pageErrors: [],
        subcases: { total: 1, passed: 0, failed: 1, details: [{ name: error.message, status: 'FAIL' }] },
        suite: 'preview'
      });
    }
  }

  async runPreviewWhisper(results) {
    const testName = 'WebNN Developer Preview Whisper Base';
    const startTime = Date.now();
    console.log(`Running preview test: ${testName}`);
    const audioFile = path.resolve(__dirname, '..', 'assets', 'test.wav');

    try {
      await this.page.goto('https://microsoft.github.io/webnn-developer-preview/demos/whisper-base/');
      await this.page.waitForLoadState('domcontentloaded');
      console.log('[Success] Navigated to Whisper Base demo');

      // Wait for model load (label remove disabled class)
      const label = this.page.locator('label#label-file-upload');
      console.log('Waiting for model to load...');
      await expect(label).not.toHaveClass(/disabled/, { timeout: 600000 });
      console.log('[Success] Model loaded');

      // Upload file
      const fileInput = this.page.locator('#file-upload');
      await fileInput.setInputFiles(audioFile);
      console.log(`[Success] Uploaded audio file: ${audioFile}`);

      // Wait for result
      console.log('Waiting for latency result...');
      const latencyLocator = this.page.locator('xpath=//*[@id="latency"]');

      // Wait for text to appear in latency
      await expect(async () => {
         const text = await latencyLocator.textContent();
         expect(text).toContain('100.0%');
      }).toPass({ timeout: 600000 });

      let latencyText = (await latencyLocator.textContent()).trim();

      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`[Pass] Test PASSED: Whisper result: ${latencyText}`);

      results.push({
          testName: testName,
          testUrl: this.page.url(),
          result: 'PASS',
          executionTime: executionTime,
          details: `Result: ${latencyText}`,
          subcases: { total: 1, passed: 1, failed: 0, details: [{ name: `Result: ${latencyText}`, status: 'PASS' }] },
          suite: 'preview'
      });

    } catch (error) {
       console.error(`[Fail] Whisper test failed: ${error.message}`);
       const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
       results.push({
        testName: testName,
        testUrl: this.page.url(),
        result: 'FAIL',
        executionTime: executionTime,
        errors: [{ text: error.message, selector: 'exception' }],
        fullText: error.message,
        hasErrors: true,
        consoleErrors: [],
        pageErrors: [],
        subcases: { total: 1, passed: 0, failed: 1, details: [{ name: error.message, status: 'FAIL' }] },
        suite: 'preview'
      });
    }
  }
}

module.exports = { PreviewRunner };
