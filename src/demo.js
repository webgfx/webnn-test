
const { WebNNRunner } = require('./util');

class DemoRunner extends WebNNRunner {
  async runSamplesTests() {
    console.log('[Info] Running SAMPLE suite...');

    const testCaseFilter = process.env.SAMPLE_CASE || process.env.DEMO_CASE;
    let testCases = [];

    if (testCaseFilter) {
      testCases = testCaseFilter.split(',').map(c => c.trim()).filter(c => c.length > 0);
      console.log(`Running specific sample test cases: ${testCases.join(', ')}`);
    } else {
      testCases = ['lenet', 'segmentation', 'style', 'od'];
      console.log('Running all sample test cases');
    }

    const results = [];

    for (const testCase of testCases) {
      const startTime = Date.now();
      try {
        await this.runTestWithSessionCheck(async () => {
          switch (testCase) {
            case 'lenet':
              await this.runSamplesLenet(results);
              break;
            case 'segmentation':
              await this.runSamplesSemanticSegmentation(results);
              break;
            case 'style':
              await this.runSamplesStyleTransfer(results);
              break;
            case 'od':
              await this.runSamplesObjectDetection(results);
              break;
            default:
              console.log(`[Warning] Unknown sample test case: ${testCase}`);
              results.push({
                testName: `Sample: ${testCase}`,
                testUrl: '',
                result: 'ERROR',
                errors: [{ text: `Unknown test case: ${testCase}`, selector: 'exception' }],
                fullText: `Unknown test case: ${testCase}`,
                hasErrors: true,
                details: `Unknown test case: ${testCase}`,
                subcases: { total: 1, passed: 0, failed: 1, details: [] },
                suite: 'sample'
              });
          }
        });
      } catch (error) {
        console.error(`[Fail] Error running sample test case ${testCase}:`, error.message);
        results.push({
           testName: `Sample: ${testCase}`,
           result: 'ERROR',
           errors: [{ text: error.message }],
           hasErrors: true,
           subcases: { total: 1, passed: 0, failed: 1 },
           suite: 'sample'
        });
      }
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      if (results.length > 0) {
        results[results.length - 1].executionTime = duration;
      }
    }
    return results;
  }


  async runSamplesLenet(results) {
    const testName = 'LeNet Digit Recognition';
    const testUrl = 'https://webmachinelearning.github.io/webnn-samples/lenet/';

    try {
      console.log(`Running sample test: ${testName}`);
      await this.page.goto(testUrl, { waitUntil: 'networkidle' });
      await this.page.waitForTimeout(3000);

      // Select Backend: WebNN (GPU)
      try {
        await this.page.click('//*[@id="backendBtns"]/label[2]');
      } catch (e) { throw new Error('Could not click WebNN (GPU) button: ' + e.message); }

      await this.page.waitForTimeout(1000);

      // Click Predict
      try {
         await this.page.click('//*[@id="predict"]');
      } catch (e) { throw new Error('Could not click Predict button: ' + e.message); }

      // Check results
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
            suite: 'sample'
        });
      } else {
         throw new Error('Timeout waiting for inference results #label0/#prob0');
      }

    } catch (error) {
       console.error(`[Fail] Error in ${testName}:`, error.message);
       results.push({
          testName: testName,
          testUrl: testUrl,
          result: 'FAIL',
          details: error.message,
          subcases: { total: 1, passed: 0, failed: 1 },
          suite: 'sample'
       });
    }
  }

  async runSamplesSemanticSegmentation(results) {
    const testName = 'Semantic Segmentation (DeepLab V3 MobileNet V2)';
    const testUrl = 'https://webmachinelearning.github.io/webnn-samples/semantic_segmentation/';

    try {
      console.log(`Running sample test: ${testName}`);
      await this.page.goto(testUrl, { waitUntil: 'networkidle' });
      await this.page.waitForTimeout(3000);

      // Select Backend: WebNN (GPU)
      try {
        await this.page.click('//*[@id="backendBtns"]/label[2]');
      } catch (e) { throw new Error('Could not click WebNN (GPU) button: ' + e.message); }

      await this.page.waitForTimeout(1000);

      // Select Model: DeepLab V3 MobileNet V2
      // Using locator().filter() as suggested is robust, but requires newer playwright syntax that might not be available on 'this.page' if it's an older handle.
      // We will try standard selectors first.
      // Usually inputs are inside labels. We can look for the label text.
      // Trying to find label containing 'DeepLab V3 MobileNet V2' and click it.
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
             // Fallback: try clicking the input directly if visible, or by ID if wrapped in label for="deeplabv3mnv2"
             // Sample often uses <label for="deeplabv3mnv2">...</label>
             const labelFor = await this.page.$('label[for="deeplabv3mnv2"]');
             if (labelFor) {
                await labelFor.click();
                clicked = true;
             } else {
                 await this.page.click('#deeplabv3mnv2'); // Last resort
             }
        }
      } catch (e) {
         console.log('Error selecting model, trying alternative selector...', e.message);
         // Fallback to text selector
         await this.page.click("text=DeepLab V3 MobileNet V2");
      }

      console.log('Model selected, waiting for results...');

      // Wait for inference time to appear (indicating completion)
      // #computeTime span will have text 'X ms'
      let computeTimeText = '';
      let checkCount = 0;
      const maxChecks = 60; // 30s as model might need download

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
                suite: 'sample'
            });
            return;
        }

        await this.page.waitForTimeout(500);
      }

      throw new Error('Timeout waiting for inference results (#computeTime)');

    } catch (error) {
       console.error(`[Fail] Error in ${testName}:`, error.message);
       results.push({
          testName: testName,
          testUrl: testUrl,
          result: 'FAIL',
          details: error.message,
          subcases: { total: 1, passed: 0, failed: 1 },
          suite: 'sample'
       });
    }
  }

  async runSamplesStyleTransfer(results) {
    const testName = 'Fast Style Transfer';
    const testUrl = 'https://webmachinelearning.github.io/webnn-samples/style_transfer/';

    try {
      console.log(`Running sample test: ${testName}`);
      await this.page.goto(testUrl, { waitUntil: 'networkidle' });
      await this.page.waitForTimeout(3000);

      // Trigger: Select 'WebNN (GPU)' backend
      // Try clicking the label containing text 'WebNN (GPU)'
      try {
        const labels = await this.page.$$('label');
        let clicked = false;
        for (const label of labels) {
            const text = await label.innerText();
            if (text.includes('WebNN (GPU)')) {
                await label.click();
                clicked = true;
                break;
            }
        }
        if (!clicked) {
           // Fallback to text selector
           await this.page.click("text=WebNN (GPU)");
        }
      } catch (e) {
         console.log('Error selecting backend, trying alternative selector...', e.message);
         // Fallback: try clicking #webnn_gpu
         await this.page.click('#webnn_gpu');
      }

      console.log('Backend selected, waiting for results...');

      // Wait for inference time (#computeTime) to be populated
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
            console.log(`Got Style Transfer results: Load=${times.load}, Build=${times.build}, Inference=${times.compute}`);
            results.push({
                testName: testName,
                testUrl: testUrl,
                result: 'PASS',
                details: `Load: ${times.load}, Build: ${times.build}, Inference: ${times.compute}`,
                subcases: { total: 1, passed: 1, failed: 0 },
                suite: 'sample'
            });
            return;
        }

        await this.page.waitForTimeout(500);
      }

      throw new Error('Timeout waiting for inference results (#computeTime)');

    } catch (error) {
       console.error(`[Fail] Error in ${testName}:`, error.message);
       results.push({
          testName: testName,
          testUrl: testUrl,
          result: 'FAIL',
          details: error.message,
          subcases: { total: 1, passed: 0, failed: 1 },
          suite: 'sample'
       });
    }
  }
  async runSamplesObjectDetection(results) {
    const testName = 'Object Detection (Tiny Yolo V2)';
    const testUrl = 'https://webmachinelearning.github.io/webnn-samples/object_detection/';

    try {
      console.log(`Running sample test: ${testName}`);
      await this.page.goto(testUrl, { waitUntil: 'networkidle' });
      await this.page.waitForTimeout(3000);

      // Select Backend: WebNN (GPU)
      try {
        const labels = await this.page.$$('label');
        let clicked = false;
        for (const label of labels) {
            const text = await label.innerText();
            if (text.includes('WebNN (GPU)')) {
                await label.click();
                clicked = true;
                break;
            }
        }
        if (!clicked) await this.page.click("text=WebNN (GPU)");
      } catch (e) {
         console.warn('Error selecting backend, trying alternative selector...', e.message);
         await this.page.click('#webnn_gpu');
      }

      await this.page.waitForTimeout(1000);

      // Select Float16
      try {
        const labels = await this.page.$$('label');
        let clicked = false;
        for (const label of labels) {
            const text = await label.innerText();
            if (text.includes('Float16')) {
                await label.click();
                clicked = true;
                break;
            }
        }
        if (!clicked) await this.page.click("text=Float16");
      } catch (e) {
        console.warn('Error selecting Float16:', e.message);
      }

      await this.page.waitForTimeout(1000);

      // Select Model: Tiny Yolo V2
      try {
        const labels = await this.page.$$('label');
        let clicked = false;
        for (const label of labels) {
            const text = await label.innerText();
            if (text.includes('Tiny Yolo V2')) {
                await label.click();
                clicked = true;
                break;
            }
        }
        if (!clicked) await this.page.click("text=Tiny Yolo V2");
      } catch (e) {
         console.warn('Error selecting model:', e.message);
      }

      console.log('Model selected, waiting for results...');

      // Wait for inference time using //*[@id="computeTime"]
      let computeTimeText = '';
      let listContent = '';
      let checkCount = 0;
      const maxChecks = 60; // 30s

      while (checkCount < maxChecks) {
        checkCount++;
        const result = await this.page.evaluate(() => {
            const computeEl = document.evaluate('//*[@id="computeTime"]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;

            if (computeEl && computeEl.innerText.includes('ms')) {
                 const listEl = document.evaluate('//*[@id="container"]/div[4]/ul', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                 return {
                    compute: computeEl.innerText,
                    content: listEl ? listEl.innerText.trim() : ''
                 };
            }
            return null;
        });

        if (result) {
            computeTimeText = result.compute;
            listContent = result.content.replace(/\n/g, ', ');
            console.log(`Got Object Detection results: ${listContent}`);
            break;
        }
        await this.page.waitForTimeout(500);
      }

      if (listContent) {
        results.push({
            testName: testName,
            testUrl: testUrl,
            result: 'PASS',
            details: listContent,
            subcases: { total: 1, passed: 1, failed: 0 },
            suite: 'sample'
        });
      } else {
        throw new Error('Timeout waiting for inference results (//*[@id="computeTime"])');
      }

    } catch (error) {
       console.error(`[Fail] Error in ${testName}:`, error.message);
       results.push({
          testName: testName,
          testUrl: testUrl,
          result: 'FAIL',
          details: error.message,
          subcases: { total: 1, passed: 0, failed: 1 },
          suite: 'sample'
       });
    }
  }
}

module.exports = { DemoRunner };
