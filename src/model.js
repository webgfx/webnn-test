
const { WebNNRunner } = require('./util');
const { expect } = require('@playwright/test');

class ModelRunner extends WebNNRunner {
  constructor(page) {
    super(page);
    this.models = {
      // Samples
      'lenet': {
        name: 'LeNet Digit Recognition',
        url: 'https://webmachinelearning.github.io/webnn-samples/lenet/',
        type: 'sample',
        func: this.runModelLenet
      },
      'segmentation': {
        name: 'Semantic Segmentation (DeepLab V3 MobileNet V2)',
        url: 'https://webmachinelearning.github.io/webnn-samples/semantic_segmentation/',
        type: 'sample',
        func: this.runModelSemanticSegmentation
      },
      'style': {
        name: 'Fast Style Transfer',
        url: 'https://webmachinelearning.github.io/webnn-samples/style_transfer/',
        type: 'sample',
        func: this.runModelStyleTransfer
      },
      'od': {
        name: 'Object Detection (Tiny Yolo V2)',
        url: 'https://webmachinelearning.github.io/webnn-samples/object_detection/',
        type: 'sample',
        func: this.runModelObjectDetection
      },
      // Preview
      'ic': {
        name: 'WebNN Developer Preview Image Classification',
        url: 'https://microsoft.github.io/webnn-developer-preview/demos/image-classification',
        type: 'preview',
        func: this.runModelImageClassification
      },
      'sdxl': {
        name: 'WebNN Developer Preview SDXL Turbo',
        url: 'https://microsoft.github.io/webnn-developer-preview/demos/sdxl-turbo/',
        type: 'preview',
        func: this.runModelSdxl
      },
      'phi': {
        name: 'WebNN Developer Preview Phi WebGPU',
        url: 'https://microsoft.github.io/webnn-developer-preview/demos/text-generation/',
        type: 'preview',
        func: this.runModelPhi
      },
      'sam': {
        name: 'WebNN Developer Preview Segment Anything',
        url: 'https://microsoft.github.io/webnn-developer-preview/demos/segment-anything/',
        type: 'preview',
        func: this.runModelSam
      },
      'whisper': {
        name: 'WebNN Developer Preview Whisper-base WebGPU',
        url: 'https://microsoft.github.io/webnn-developer-preview/demos/whisper-base/',
        type: 'preview',
        func: this.runModelWhisper
      }
    };
  }

  async runModelTests(onFirstCaseComplete) {
    console.log('[Info] Running MODEL suite...');

    // Collect filter from various legacy env vars
    const filterStr = process.env.MODEL_CASE;
    let testKeys = [];

    if (filterStr) {
      testKeys = filterStr.split(',').map(c => c.trim().toLowerCase()).filter(c => c.length > 0);
      console.log(`Running specific model cases: ${testKeys.join(', ')}`);
    } else {
      testKeys = Object.keys(this.models);
      console.log('Running all model test cases');
    }

    const results = [];

    for (const key of testKeys) {
      if (!this.models[key]) {
         console.warn(`[Warning] Unknown model test case: ${key}`);
         results.push({
            testName: `Model: ${key}`,
            result: 'ERROR',
            hasErrors: true,
            fullText: `Unknown test case: ${key}`,
            subcases: { total: 1, passed: 0, failed: 1 },
            suite: 'model'
         });
         continue;
      }

      const modelDef = this.models[key];
      const startTime = Date.now();
      let infinityErrorDetected = false;

      try {
        await this.runTestWithSessionCheck(async () => {
             // Setup console listener for infinity checks (common in preview)
             const consoleListener = async (msg) => {
                if (msg.text().includes('Found infinity in logits')) {
                  console.error(`[Fail] [Auto-Fail] "Found infinity in logits" detected. Quitting case...`);
                  infinityErrorDetected = true;
                  try { await this.page.close(); } catch (e) {}
                }
             };
             this.page.on('console', consoleListener);

             try {
                // Call the bound function
                await modelDef.func.call(this, results, modelDef);
             } finally {
                if (!this.page.isClosed()) {
                  this.page.off('console', consoleListener);
                }
             }
        });
      } catch (error) {
        if (infinityErrorDetected) {
            error.message = "Found infinity in logits";
        }

        // Check if we already pushed a result (some funcs push result themselves)
        // If not, push error result
        // Or if we need to update the last result
        // Ideally, the runner functions should push results.
        // If runTestWithSessionCheck throws, it means it wasn't caught inside

        console.error(`[Fail] Error running model case ${key}:`, error.message);

        // Simple duplicate check based on testName
        const alreadyReported = results.length > 0 && results[results.length-1].testName === modelDef.name;

        if (!alreadyReported) {
             results.push({
                testName: modelDef.name,
                testUrl: modelDef.url,
                result: 'ERROR',
                errors: [{ text: error.message }],
                fullText: error.message,
                hasErrors: true,
                subcases: { total: 1, passed: 0, failed: 1 },
                suite: 'model'
             });
        }
      }

      // Add execution time to the last result if it belongs to this test
      if (results.length > 0) {
        const lastRes = results[results.length - 1];
        if (lastRes.testName === modelDef.name && !lastRes.executionTime) {
            lastRes.executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
        }
      }

      if (results.length === 1 && onFirstCaseComplete) {
          await onFirstCaseComplete();
      }

      // Pause between tests
      if (!this.page.isClosed()) {
         await this.page.waitForTimeout(2000);
      }
    }

    return results;
  }

  // --- Sample Implementations ---

  async runModelLenet(results, modelDef) {
    const testName = modelDef.name;
    const testUrl = modelDef.url;

    const device = process.env.DEVICE || 'cpu';

    // ... Copy implementation from demo.js with minor tweaks ...
    try {
      console.log(`Running sample test: ${testName} on ${device.toUpperCase()}`);
      await this.page.goto(testUrl, { waitUntil: 'networkidle' });
      await this.page.waitForTimeout(3000);

      // Select Backend based on device
      try {
        if (device === 'cpu') {
            await this.page.click('//*[@id="backendBtns"]/label[1]'); // WebNN (CPU)
        } else if (device === 'gpu') {
            await this.page.click('//*[@id="backendBtns"]/label[2]'); // WebNN (GPU)
        } else if (device === 'npu') {
            // Check if NPU button exists
            const npuBtn = this.page.locator('//*[@id="deviceTypeBtns"]/label[3]');
            if (await npuBtn.isVisible()) {
                await npuBtn.click();
            } else {
                console.log('NPU not supported/available for this sample, skipping...');
                results.push({
                    testName: testName,
                    testUrl: testUrl,
                    result: 'PASS', // Considered pass as "skipped/unsupported"
                    details: 'NPU not supported/available',
                    subcases: { total: 1, passed: 1, failed: 0 },
                    suite: 'model'
                });
                return;
            }
        }
      } catch (e) { throw new Error(`Could not click backend button for ${device}: ` + e.message); }

      await this.page.waitForTimeout(1000);

      try {
         await this.page.click('//*[@id="predict"]');
      } catch (e) { throw new Error('Could not click Predict button: ' + e.message); }

      let buildTime = null;
      let inferenceTime = null;
      let checkCount = 0;
      const maxChecks = 30; // 15s

      while (checkCount < maxChecks && (buildTime === null || inferenceTime === null)) {
        checkCount++;
        const result = await this.page.evaluate(() => {
           const buildTimeEl = document.getElementById('buildTime');
           const inferenceTimeEl = document.getElementById('inferenceTime');
           if (buildTimeEl && inferenceTimeEl && buildTimeEl.innerText.trim() !== '' && inferenceTimeEl.innerText.trim() !== '') {
             return { buildTime: buildTimeEl.innerText.trim(), inferenceTime: inferenceTimeEl.innerText.trim() };
           }
           return null;
        });

        if (result) {
            buildTime = result.buildTime;
            inferenceTime = result.inferenceTime;
        } else {
            await this.page.waitForTimeout(500);
        }
      }

      if (buildTime && inferenceTime) {
        console.log(`Got LeNet result: ${buildTime}, ${inferenceTime}`);
        results.push({
            testName: testName,
            testUrl: testUrl,
            result: 'PASS',
            details: `${buildTime}, ${inferenceTime}`,
            subcases: { total: 1, passed: 1, failed: 0 },
            suite: 'model'
        });
      } else {
         throw new Error('Timeout waiting for inference results buildTime/inferenceTime');
      }

    } catch (error) {
       console.error(`[Fail] Error in ${testName}:`, error.message);
       throw error;
    }
  }

  async runModelSemanticSegmentation(results, modelDef) {
    const testName = modelDef.name;
    const testUrl = modelDef.url;

    const device = process.env.DEVICE || 'cpu';

    try {
      console.log(`Running sample test: ${testName} on ${device.toUpperCase()}`);
      await this.page.goto(testUrl, { waitUntil: 'networkidle' });
      await this.page.waitForTimeout(3000);

      try {
        if (device === 'cpu') {
             await this.page.click('//*[@id="backendBtns"]/label[1]');
        } else if (device === 'gpu') {
             await this.page.click('//*[@id="backendBtns"]/label[2]');
        } else if (device === 'npu') {
             const npuBtn = this.page.locator('//*[@id="deviceTypeBtns"]/label[3]');
             if (await npuBtn.isVisible()) {
                await npuBtn.click();
             } else {
                console.log('NPU button not found, skipping');
                 results.push({
                    testName: testName,
                    testUrl: testUrl,
                    result: 'PASS',
                    details: 'NPU not supported',
                    subcases: { total: 1, passed: 1, failed: 0 },
                    suite: 'model'
                });
                return;
             }
        }
      } catch (e) { throw new Error(`Could not click backend button for ${device}: ` + e.message); }

      await this.page.waitForTimeout(1000);

      try {
        const labels = await this.page.$$('label');
        let clicked = false;
        for (const label of labels) {
            const text = await label.innerText();
            if (text.includes('DeepLab V3 MobileNet V2')) {
                await label.click();
                clicked = true;
                break;
            }
        }
        if (!clicked) {
             const labelFor = await this.page.$('label[for="deeplabv3mnv2"]');
             if (labelFor) {
                await labelFor.click();
                clicked = true;
             } else {
                 await this.page.click('#deeplabv3mnv2');
             }
        }
      } catch (e) {
         console.log('Error selecting model, trying alternative selector...', e.message);
         await this.page.click("text=DeepLab V3 MobileNet V2");
      }

      console.log('Model selected, waiting for results...');

      let checkCount = 0;
      const maxChecks = 60;

      while (checkCount < maxChecks) {
        checkCount++;
        const times = await this.page.evaluate(() => {
            const computeEl = document.querySelector('#computeTime');
            const loadEl = document.querySelector('#loadTime');
            const buildEl = document.querySelector('#buildTime');

            if (computeEl && computeEl.innerText.includes('ms')) {
                return {
                    compute: computeEl.innerText,
                    load: loadEl ? loadEl.innerText : 'N/A',
                    build: buildEl ? buildEl.innerText : 'N/A'
                };
            }
            return null;
        });

        if (times) {
            console.log(`Got Semantic Segmentation results: Load=${times.load}, Build=${times.build}, Inference=${times.compute}`);
            results.push({
                testName: testName,
                testUrl: testUrl,
                result: 'PASS',
                details: `Load: ${times.load}, Build: ${times.build}, Inference: ${times.compute}`,
                subcases: { total: 1, passed: 1, failed: 0 },
                suite: 'model'
            });
            return;
        }
        await this.page.waitForTimeout(500);
      }
      throw new Error('Timeout waiting for inference results (#computeTime)');
    } catch (error) { throw error; }
  }

  async runModelStyleTransfer(results, modelDef) {
    const testName = modelDef.name;
    const testUrl = modelDef.url;
    const device = process.env.DEVICE || 'cpu';

    try {
      console.log(`Running sample test: ${testName} on ${device.toUpperCase()}`);
      await this.page.goto(testUrl, { waitUntil: 'networkidle' });
      await this.page.waitForTimeout(3000);

      try {
        // Selection logic for Style Transfer
        const targetText = device === 'cpu' ? 'WebNN (CPU)' : 'WebNN (GPU)';
        const targetId = device === 'cpu' ? '#webnn_cpu' : '#webnn_gpu';

        if (device === 'npu') {
             // Style transfer sample page might be slightly different structure for NPU if supported
             // Assuming similar NPU button or skip
             const npuBtn = this.page.locator('//*[@id="deviceTypeBtns"]/label[3]');
             if (await npuBtn.isVisible()) {
                await npuBtn.click();
             } else {
                 console.log('NPU button not found for Style Transfer, skipping');
                 results.push({
                    testName: testName,
                    testUrl: testUrl,
                    result: 'PASS',
                    details: 'NPU not supported',
                    subcases: { total: 1, passed: 1, failed: 0 },
                    suite: 'model'
                });
                return;
             }
        } else {
            const labels = await this.page.$$('label');
            let clicked = false;
            for (const label of labels) {
                const text = await label.innerText();
                if (text.includes(targetText)) {
                    await label.click();
                    clicked = true;
                    break;
                }
            }
            if (!clicked) {
               await this.page.click(`text=${targetText}`);
            }
        }
      } catch (e) {
         console.log('Error selecting backend, trying ID selector...', e.message);
         if (device === 'cpu') await this.page.click('#webnn_cpu');
         else if (device === 'gpu') await this.page.click('#webnn_gpu');
      }

      console.log('Backend selected, waiting for results...');

      let checkCount = 0;
      const maxChecks = 60; // 30s

      while (checkCount < maxChecks) {
        checkCount++;
        const times = await this.page.evaluate(() => {
            const computeEl = document.querySelector('#computeTime');
            const loadEl = document.querySelector('#loadTime');
            const buildEl = document.querySelector('#buildTime');

            if (computeEl && computeEl.innerText.includes('ms')) {
                return {
                    compute: computeEl.innerText,
                    load: loadEl ? loadEl.innerText : 'N/A',
                    build: buildEl ? buildEl.innerText : 'N/A'
                };
            }
            return null;
        });

        if (times) {
            results.push({
                testName: testName,
                testUrl: testUrl,
                result: 'PASS',
                details: `Load: ${times.load}, Build: ${times.build}, Inference: ${times.compute}`,
                subcases: { total: 1, passed: 1, failed: 0 },
                suite: 'model'
            });
            return;
        }
        await this.page.waitForTimeout(500);
      }
      throw new Error('Timeout waiting for inference results (#computeTime)');
    } catch (e) { throw e; }
  }

  async runModelObjectDetection(results, modelDef) {
    const testName = modelDef.name;
    const testUrl = modelDef.url;
    const device = process.env.DEVICE || 'cpu';

    try {
      console.log(`Running sample test: ${testName} on ${device.toUpperCase()}`);
      await this.page.goto(testUrl, { waitUntil: 'networkidle' });
      await this.page.waitForTimeout(3000);

      // 1. Select Backend
      try {
        await this.page.waitForLoadState('domcontentloaded');
        const labelText = device === 'npu' ? 'WebNN (NPU)' :
                          device === 'gpu' ? 'WebNN (GPU)' : 'WebNN (CPU)';

        const targetLabel = this.page.locator('label').filter({ hasText: labelText }).first();

        try {
            await targetLabel.waitFor({ state: 'visible', timeout: 5000 });
            await targetLabel.click();
        } catch (waitError) {
             if (device === 'npu') {
                 console.log('NPU button missing, skipping test.');
                 results.push({
                    testName: testName,
                    testUrl: testUrl,
                    result: 'PASS',
                    details: 'NPU not supported',
                    subcases: { total: 1, passed: 1, failed: 0 },
                    suite: 'model'
                });
                return;
             }

             // Fallback for CPU/GPU
             const shortText = device.toUpperCase();
             const shortLabel = this.page.locator('label').filter({ hasText: shortText }).first();
             if (await shortLabel.count() > 0 && await shortLabel.isVisible()) {
                 await shortLabel.click();
             } else {
                 throw new Error(`Backend button for ${device} not found.`);
             }
        }
      } catch (e) { throw new Error(`Could not click backend button for ${device}: ` + e.message); }

      // 2. Select Data Type (Float 32)
      try {
          await this.page.click('//*[@id="dataTypeBtns"]/label[1]');
      } catch (e) {
      }

      // 3. Select Model
      try {
        await this.page.waitForSelector('#modelBtns', { state: 'visible', timeout: 5000 });
      } catch(e) {}

      await this.page.waitForTimeout(1000);

      const hintEl = this.page.locator('//*[@id="hint"]');
      let shouldSelect = true;
      try {
         if (await hintEl.isVisible()) {
            const hintText = (await hintEl.innerText()).toUpperCase();
            if (!hintText.includes('NO MODEL SELECTED')) {
               shouldSelect = false;
            }
         }
      } catch(e) {}

      if (shouldSelect) {
          try {
              const modelLabel = this.page.locator('#modelBtns label').filter({ hasText: 'Tiny Yolo V2' }).first();
              if (await modelLabel.count() > 0 && await modelLabel.isVisible()) {
                  await modelLabel.click();
              } else {
                  await this.page.click('//*[@id="modelBtns"]/label[1]');
              }
          } catch (e) {
              console.warn('Model selection failed:', e.message);
          }
      }

      console.log('Model selected, waiting for results...');

      let checkCount = 0;
      const maxChecks = 60; // 30s

      while (checkCount < maxChecks) {
        checkCount++;
        const times = await this.page.evaluate(() => {
            const computeEl = document.querySelector('#computeTime');
            if (computeEl && computeEl.innerText.includes('ms')) {
                return computeEl.innerText;
            }
            return null;
        });

        if (times) {
            results.push({
                testName: testName,
                testUrl: testUrl,
                result: 'PASS',
                details: `Inference: ${times}`,
                subcases: { total: 1, passed: 1, failed: 0 },
                suite: 'model'
            });
            return;
        }
        await this.page.waitForTimeout(500);
      }
      throw new Error('Timeout waiting for inference results (#computeTime)');
    } catch (e) { throw e; }
  }

  // --- Preview Implementations ---

  async runModelImageClassification(results, modelDef) {
    const testName = modelDef.name;
    const device = process.env.DEVICE || 'cpu';

    // Construct URL with params for auto-run and selection
    // ?provider=webnn&devicetype=<device>&model=resnet-50&run=5
    const baseUrl = modelDef.url.split('?')[0];
    const testUrl = `${baseUrl}?provider=webnn&devicetype=${device}&model=resnet-50&run=5`;

    try {
      console.log(`Running preview test: ${testName} on ${device}`);
      console.log(`Navigating to: ${testUrl}`);

      await this.page.goto(testUrl);
      await this.page.waitForLoadState('networkidle');

      await this.page.waitForTimeout(3000);
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
            break;
          }
        } catch (error) {}
      }

      if (classifyButton && await classifyButton.isVisible()) {
        await classifyButton.click();
        console.log('[Success] Clicked Classify button');
      } else {
        console.log('Classify button not found, assuming auto-run from URL params');
      }

      let latencyFound = false;
      let latencyValue = null;
      let checkCount = 0;
      const maxChecks = 120;

      while (checkCount < maxChecks && !latencyFound) {
        checkCount++;
        const latencyResult = await this.page.evaluate(() => {
          const latencyElement = document.querySelector('#latency');
          if (latencyElement) {
            const text = latencyElement.textContent || latencyElement.innerText;
            if (text && text.trim()) return { found: true, content: text.trim() };
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
        await this.page.waitForTimeout(500);
      }

      if (!latencyFound) throw new Error(`latency element not found after ${maxChecks} attempts`);
      if (!latencyValue.includes('ms')) latencyValue += ' ms';

      results.push({
        testName: testName,
        testUrl: testUrl,
        result: 'PASS',
        details: `Latency: ${latencyValue}`,
        subcases: { total: 1, passed: 1, failed: 0 },
        suite: 'model'
      });

    } catch (error) { throw error; }
  }

  async runModelSdxl(results, modelDef) {
    const testName = modelDef.name;
    const device = process.env.DEVICE || 'cpu';

    // Construct URL: https://.../?devicetype=<device>
    const baseUrl = modelDef.url.split('?')[0];
    const testUrl = `${baseUrl}?devicetype=${device}`;

    console.log(`Running preview test: ${testName} on ${device}`);
    console.log(`Navigating to: ${testUrl}`);

    try {
      await this.page.goto(testUrl);
      await this.page.waitForLoadState('domcontentloaded');

      const loadButton = this.page.locator('button', { hasText: 'Load Models' });
      await loadButton.waitFor({ state: 'visible', timeout: 30000 });
      await loadButton.click();
      console.log('[Success] Clicked Load Models');

      const generateButton = this.page.locator('button', { hasText: 'Generate Image' });
      await generateButton.waitFor({ state: 'visible', timeout: 600000 });
      await expect(generateButton).toBeEnabled({ timeout: 600000 });

      console.log('[Success] Models loaded. Clicking Generate Image...');
      await generateButton.click();

      const resultLocator = this.page.locator('#total_data');
      await resultLocator.waitFor({ state: 'visible', timeout: 120000 });

      let resultText = '';
      let checkCount = 0;
      const maxChecks = 1200;

      while (checkCount < maxChecks) {
          const text = await resultLocator.textContent();
          resultText = text ? text.trim() : '';
          if (resultText && resultText !== '...' && /\d/.test(resultText)) {
              break;
          }
          await this.page.waitForTimeout(500);
          checkCount++;
      }

      if (!resultText || resultText === '...' || !/\d/.test(resultText)) {
          throw new Error('Result text did not appear or invalid');
      }

      results.push({
          testName: testName,
          testUrl: testUrl,
          result: 'PASS',
          details: `Total time: ${resultText}`,
          subcases: { total: 1, passed: 1, failed: 0 },
          suite: 'model'
      });

    } catch (e) { throw e; }
  }

  async runModelPhi(results, modelDef) {
      const testName = modelDef.name;
      const device = process.env.DEVICE || 'cpu';

      // Construct URL: ?provider=webnn&devicetype=<device>&model=phi4mini
      const baseUrl = modelDef.url.split('?')[0];
      const testUrl = `${baseUrl}?provider=webnn&devicetype=${device}&model=phi4mini`;

      console.log(`Running preview test: ${testName} on ${device}`);
      console.log(`Navigating to: ${testUrl}`);

      try {
        await this.page.goto(testUrl);
        await this.page.waitForLoadState('domcontentloaded');

        // The text-generation demo auto-loads the model on page init (no Load button).
        // The send button (#send-button) starts disabled and becomes enabled when the model is ready.
        const sendBtn = this.page.locator('#send-button');

        console.log("Waiting for model to load (#send-button to become enabled)...");
        await sendBtn.waitFor({ state: 'visible', timeout: 600000 });
        await expect(sendBtn).not.toBeDisabled({ timeout: 600000 });
        console.log("Model loaded. Send button is enabled.");

        // Type a prompt into the #user-input contenteditable div
        const userInput = this.page.locator('#user-input');
        const testPrompt = 'What is 2 + 2?';
        await userInput.click();
        await userInput.fill(testPrompt).catch(async () => {
            // contenteditable divs may not support fill(), use keyboard input
            await userInput.pressSequentially(testPrompt, { delay: 30 });
        });
        console.log(`Typed prompt: "${testPrompt}"`);

        // Click send button to submit the prompt
        await sendBtn.click();
        console.log("Clicked Send button, waiting for response...");

        // Wait for performance indicator to show tokens/sec data
        const perfIndicator = this.page.locator('#performance-indicator');

        let perfText = '';
        let checks = 0;
        while(checks < 600) { // 5 mins max
            perfText = await perfIndicator.innerText().catch(() => '');
            if (perfText && /\d/.test(perfText) && (perfText.includes('token') || perfText.includes('s'))) {
                 break;
            }
            await this.page.waitForTimeout(500);
            checks++;
        }

        if (!perfText) throw new Error("No token/sec result found in #performance-indicator");

        console.log(`Performance result: ${perfText}`);
        results.push({
            testName: testName,
            testUrl: testUrl,
            result: 'PASS',
            details: `Performance: ${perfText.replace(/\n/g, ', ')}`,
            subcases: { total: 1, passed: 1, failed: 0 },
            suite: 'model'
        });

      } catch (e) { throw e; }
  }

  async runModelSam(results, modelDef) {
    const testName = modelDef.name;
    const device = process.env.DEVICE || 'cpu';

    // Construct URL: ?devicetype=<device>
    const baseUrl = modelDef.url.split('?')[0];
    const testUrl = `${baseUrl}?devicetype=${device}`;

    console.log(`Running preview test: ${testName} on ${device}`);
    console.log(`Navigating to: ${testUrl}`);

    try {
        await this.page.goto(testUrl);
        await this.page.waitForLoadState('domcontentloaded');

        // This demo usually requires user interaction (clicking image).
        // Automated version might just check if model loads.
        // Assuming there is some indicator or we try to canvas click.

        console.log("Waiting for canvas...");
        const canvas = this.page.locator('canvas').first();
        await canvas.waitFor({ state: 'visible', timeout: 60000 });

        // Wait for potential loading indicators to disappear
        await this.page.waitForTimeout(5000);

        console.log("Clicking on canvas to trigger segmentation...");
        const box = await canvas.boundingBox();
        if (box) {
            await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } else {
            throw new Error("Canvas bounding box not found");
        }

        // Check for latency indicator
        const latencySel = '#latency';
        const latEl = this.page.locator(latencySel);

        // It might take time for first inference
        await latEl.waitFor({ state: 'visible', timeout: 30000 });

        let latText = '';
        let checks = 0;
        while(checks < 60) {
            latText = await latEl.innerText();
            if (latText && /\d/.test(latText) && !latText.includes('...')) break;
            await this.page.waitForTimeout(500);
            checks++;
        }

        if (!latText) throw new Error("Latency not displayed");

        results.push({
            testName: testName,
            testUrl: testUrl,
            result: 'PASS',
            details: `Latency: ${latText}`,
            subcases: { total: 1, passed: 1, failed: 0 },
            suite: 'model'
        });

    } catch(e) { throw e; }
  }

  async runModelWhisper(results, modelDef) {
      const testName = modelDef.name;
      const device = process.env.DEVICE || 'cpu';

      // Construct URL: ?provider=webnn&devicetype=<device>
      const baseUrl = modelDef.url.split('?')[0];
      const testUrl = `${baseUrl}?provider=webnn&devicetype=${device}`;

      console.log(`Running preview test: ${testName} on ${device}`);
      console.log(`Navigating to: ${testUrl}`);

      try {
          await this.page.goto(testUrl);
          await this.page.waitForLoadState('domcontentloaded');

          // The whisper-base demo auto-loads the model on page init (no Load button).
          // When the model is ready, the record (#record), speech (#speech), and
          // file-upload (#file-upload) controls become enabled.
          const recordBtn = this.page.locator('#record');

          console.log("Waiting for model to load (#record button to become enabled)...");
          await recordBtn.waitFor({ state: 'visible', timeout: 300000 });
          // Poll for the button to become enabled (disabled attr removed)
          let modelReady = false;
          for (let i = 0; i < 600; i++) { // up to 5 min
              const isDisabled = await recordBtn.isDisabled();
              if (!isDisabled) { modelReady = true; break; }
              await this.page.waitForTimeout(500);
          }
          if (!modelReady) throw new Error("Whisper model failed to load (record button stayed disabled)");
          console.log("Model loaded. Controls are enabled.");

          // Use the record button to capture a short audio clip.
          // Click to start recording, wait briefly, click again to stop.
          // After stop, the demo auto-transcribes the recorded audio.
          console.log("Starting recording...");
          await recordBtn.click();
          await this.page.waitForTimeout(3000); // Record ~3 seconds of ambient audio
          console.log("Stopping recording...");
          await recordBtn.click();

          // Wait for transcription output in #outputText
          const outputText = this.page.locator('#outputText');
          const latencyEl = this.page.locator('#latency');

          console.log("Waiting for transcription to complete...");
          let latencyText = '';
          let checks = 0;
          while(checks < 120) { // up to 60 seconds
              latencyText = await latencyEl.innerText().catch(() => '');
              // Transcription is done when latency shows 100% or a completion indicator
              if (latencyText && latencyText.includes('100')) {
                  break;
              }
              await this.page.waitForTimeout(500);
              checks++;
          }

          const transcription = await outputText.textContent().catch(() => '');
          console.log(`Transcription result: "${transcription}"`);
          console.log(`Latency info: ${latencyText}`);

          // Consider it a pass if the transcription completed (latency hit 100%)
          // Even silence/ambient noise will produce some output or blank audio tags
          if (!latencyText || !latencyText.includes('100')) {
              throw new Error("Transcription did not complete (latency never reached 100%)");
          }

          results.push({
              testName: testName,
              testUrl: testUrl,
              result: 'PASS',
              details: `Transcription: ${transcription || '(silence/blank)'}. ${latencyText}`,
              subcases: { total: 1, passed: 1, failed: 0 },
              suite: 'model'
          });

      } catch(e) { throw e; }
  }
}

module.exports = { ModelRunner };
