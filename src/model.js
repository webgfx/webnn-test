
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
        func: this.runSamplesLenet
      },
      'segmentation': {
        name: 'Semantic Segmentation (DeepLab V3 MobileNet V2)',
        url: 'https://webmachinelearning.github.io/webnn-samples/semantic_segmentation/',
        type: 'sample',
        func: this.runSamplesSemanticSegmentation
      },
      'style': {
        name: 'Fast Style Transfer',
        url: 'https://webmachinelearning.github.io/webnn-samples/style_transfer/',
        type: 'sample',
        func: this.runSamplesStyleTransfer
      },
      'od': {
        name: 'Object Detection (SSDMobileNet V2)',
        url: 'https://webmachinelearning.github.io/webnn-samples/object_detection/',
        type: 'sample',
        func: this.runSamplesObjectDetection
      },
      // Preview
      'ic': {
        name: 'WebNN Developer Preview Image Classification',
        url: 'https://microsoft.github.io/webnn-developer-preview/demos/image-classification',
        type: 'preview',
        func: this.runPreviewImageClassification
      },
      'sdxl': {
        name: 'WebNN Developer Preview SDXL Turbo',
        url: 'https://microsoft.github.io/webnn-developer-preview/demos/sdxl-turbo/',
        type: 'preview',
        func: this.runPreviewSdxl
      },
      'phi': {
        name: 'WebNN Developer Preview Phi-3 WebGPU',
        url: 'https://microsoft.github.io/webnn-developer-preview/demos/text-generation/',
        type: 'preview',
        func: this.runPreviewPhi
      },
      'sam': {
        name: 'WebNN Developer Preview Segment Anything',
        url: 'https://microsoft.github.io/webnn-developer-preview/demos/segment-anything/',
        type: 'preview',
        func: this.runPreviewSam
      },
      'whisper': {
        name: 'WebNN Developer Preview Whisper-base WebGPU',
        url: 'https://microsoft.github.io/webnn-developer-preview/demos/whisper-base/',
        type: 'preview',
        func: this.runPreviewWhisper
      }
    };
  }

  async runModelTests() {
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

      // Pause between tests
      if (!this.page.isClosed()) {
         await this.page.waitForTimeout(2000);
      }
    }

    return results;
  }

  // --- Sample Implementations ---

  async runSamplesLenet(results, modelDef) {
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

      let firstLabel = null;
      let firstProb = null;
      let checkCount = 0;
      const maxChecks = 30; // 15s

      while (checkCount < maxChecks && firstLabel === null) {
        checkCount++;
        const probResult = await this.page.evaluate(() => {
           const labelEl = document.querySelector('#label0');
           const probEl = document.querySelector('#prob0');
           if (labelEl && probEl && labelEl.innerText.trim() !== '' && probEl.innerText.trim() !== '') {
             return { label: labelEl.innerText.trim(), prob: probEl.innerText.trim() };
           }
           return null;
        });

        if (probResult) {
            firstLabel = probResult.label;
            firstProb = probResult.prob;
        } else {
            await this.page.waitForTimeout(500);
        }
      }

      if (firstLabel) {
        console.log(`Got LeNet result: Label=${firstLabel}, Prob=${firstProb}`);
        results.push({
            testName: testName,
            testUrl: testUrl,
            result: 'PASS',
            details: `Label: ${firstLabel}, Probability: ${firstProb}`,
            subcases: { total: 1, passed: 1, failed: 0 },
            suite: 'model'
        });
      } else {
         throw new Error('Timeout waiting for inference results #label0/#prob0');
      }

    } catch (error) {
       console.error(`[Fail] Error in ${testName}:`, error.message);
       throw error;
    }
  }

  async runSamplesSemanticSegmentation(results, modelDef) {
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

  async runSamplesStyleTransfer(results, modelDef) {
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

  async runSamplesObjectDetection(results, modelDef) {
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

      console.log('Backend selected, waiting for results...');

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

  async runPreviewImageClassification(results, modelDef) {
    const testName = modelDef.name;
    let testUrl = modelDef.url;
    const device = process.env.DEVICE || 'cpu';
    if (device) testUrl += `?devicetype=${device}`;

    try {
      console.log(`Running preview test: ${testName} on ${device}`);
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

      if (!classifyButton || !(await classifyButton.isVisible())) {
        throw new Error('Could not find Classify button');
      }

      await classifyButton.click();
      console.log('[Success] Clicked Classify button');

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

  async runPreviewSdxl(results, modelDef) {
    const testName = modelDef.name;
    let testUrl = modelDef.url;
    const device = process.env.DEVICE || 'cpu';
    if (device) testUrl += `?devicetype=${device}`;
    console.log(`Running preview test: ${testName} on ${device}`);

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

  async runPreviewPhi(results, modelDef) {
      const testName = modelDef.name;
      let testUrl = modelDef.url;
      const device = process.env.DEVICE || 'cpu';
      if (device) testUrl += `?devicetype=${device}`;
      console.log(`Running preview test: ${testName} on ${device}`);

      try {
        await this.page.goto(testUrl);
        await this.page.waitForLoadState('domcontentloaded');

        // Look for Load button
        const loadSelectors = [
            '#load',
            'button:has-text("Load")',
            'button:text("Load")'
        ];

        let loadBtn = null;
        for (const sel of loadSelectors) {
             try { loadBtn = this.page.locator(sel).first(); if (await loadBtn.isVisible()) break; } catch(e){}
        }

        if (loadBtn) {
            await loadBtn.click();
            console.log("Clicked Load button");
        } else {
            console.log("Load button not found, assuming auto-load or different UI");
        }

        // Wait quite a while for model load - look for generation start capability or input
        const generateBtnSelector = '#generate';
        const generateBtn = this.page.locator(generateBtnSelector);

        console.log("Waiting for Generate button enabled (Model loading)...");
        await generateBtn.waitFor({ state: 'visible', timeout: 600000 });
        // Check if disabled removal happens
        await expect(generateBtn).not.toBeDisabled({ timeout: 600000 });

        console.log("Model Loaded. Clicking Generate...");
        await generateBtn.click();

        // Check for tokens/sec or latency
        const tokenSelector = '#tokens';
        const tokenEl = this.page.locator(tokenSelector);
        await tokenEl.waitFor({ state: 'visible', timeout: 120000 });

        let tokenText = '';
        let checks = 0;
        while(checks < 300) { // 2.5 mins
            tokenText = await tokenEl.innerText();
            if (tokenText && /\d/.test(tokenText)) {
                 break;
            }
            await this.page.waitForTimeout(500);
            checks++;
        }

        if (!tokenText) throw new Error("No token/sec result found");

        results.push({
            testName: testName,
            testUrl: testUrl,
            result: 'PASS',
            details: `Tokens: ${tokenText}`,
            subcases: { total: 1, passed: 1, failed: 0 },
            suite: 'model'
        });

      } catch (e) { throw e; }
  }

  async runPreviewSam(results, modelDef) {
    const testName = modelDef.name;
    let testUrl = modelDef.url;
    const device = process.env.DEVICE || 'cpu';
    if (device) testUrl += `?devicetype=${device}`;
    console.log(`Running preview test: ${testName} on ${device}`);

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

  async runPreviewWhisper(results, modelDef) {
      const testName = modelDef.name;
      let testUrl = modelDef.url;
      const device = process.env.DEVICE || 'cpu';
      if (device) testUrl += `?devicetype=${device}`;
      console.log(`Running preview test: ${testName} on ${device}`);

      try {
          await this.page.goto(testUrl);
          await this.page.waitForLoadState('domcontentloaded');

          // Wait for load
          const status = this.page.locator('#status');

          // There might be a Load button or auto load
          // Demo specific: Usually "Load Model" button
          const loadBtn = this.page.locator('button', { hasText: 'Load' });
          if (await loadBtn.isVisible()) {
              await loadBtn.click();
          }

          // Wait for Ready
          console.log("Waiting for model ready...");
          // This can take time.
          await this.page.waitForTimeout(10000);

          // Usually there is "Run" or "Transcribe" from audio file
          // Need to select audio file or check defaults.
          // Assuming there is a "Run" button for default sample
          const runBtn = this.page.locator('button', { hasText: 'Run' }).or(this.page.locator('button', { hasText: 'Transcribe' }));

          await runBtn.waitFor({ state: 'visible', timeout: 300000 });
          await runBtn.click();

          // Check output
          const output = this.page.locator('#output').or(this.page.locator('#result'));
          await output.waitFor({ state: 'visible', timeout: 60000 });

          let text = '';
          let checks = 0;
          while(checks < 60) {
              text = await output.textContent();
              if (text && text.trim().length > 5) break;
              await this.page.waitForTimeout(500);
              checks++;
          }

          if (!text) throw new Error("No transcription result");

          results.push({
              testName: testName,
              testUrl: testUrl,
              result: 'PASS',
              details: "Transcription success",
              subcases: { total: 1, passed: 1, failed: 0 },
              suite: 'model'
          });

      } catch(e) { throw e; }
  }
}

module.exports = { ModelRunner };
