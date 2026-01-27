
const { test } = require('@playwright/test');
const { WebNNRunner } = require('./util');

class WptRunner extends WebNNRunner {
  async runWptTests(context, browser) {
    // Configuration
    const wptCase = process.env.WPT_CASE;
    const specifiedJobs = process.env.JOBS;
    const jobs = specifiedJobs ? parseInt(specifiedJobs, 10) : 1;
    let testCases = [];
    let selectedIndices = new Set();
    const rangeFilter = process.env.WPT_RANGE;

    // Parse range filter if provided (e.g., "1,3-5,10")
    if (rangeFilter) {
      const parts = rangeFilter.split(',');
      parts.forEach(part => {
        if (part.includes('-')) {
          const [start, end] = part.split('-').map(Number);
          for (let i = start; i <= end; i++) selectedIndices.add(i);
        } else {
          selectedIndices.add(Number(part));
        }
      });
      console.log(`Debug: Parsed range filter. Selected indices count: ${selectedIndices.size}`);
    }

    if (wptCase) {
      testCases = wptCase.split(',').map(c => c.trim()).filter(Boolean);
    }

    console.log(`Running WPT tests. Case: ${wptCase || 'ALL'}, Range: ${rangeFilter || 'ALL'}, Jobs: ${jobs}`);

    const baseWptUrl = 'https://wpt.live/webnn/conformance_tests/';

    // 1. Discover Tests
    if (!this.page) {
        throw new Error("WptRunner requires a page in constructor for discovery");
    }

    await this.page.goto(baseWptUrl);
    await this.page.waitForSelector('.file');

    let testFiles = await this.page.$$eval('.file', elements => {
      return elements
        .map(el => {
          const link = el.querySelector('a');
          return link ? link.textContent.trim() : null;
        })
        .filter(name => name && name.endsWith('.js'));
    });

    console.log(`[Success] Test discovery complete. Found ${testFiles.length} files.`);
    await this.page.close();

    // 2. Filter Tests
    if (testCases.length > 0) {
      const orderedTestFiles = [];
      testCases.forEach(testCase => {
        const caseFiles = testFiles.filter(testFile => {
          const baseName = testFile.replace('.https.any.js', '').replace('.js', '');
          return baseName.toLowerCase() === testCase.toLowerCase();
        });
        orderedTestFiles.push(...caseFiles);
      });
      testFiles = [...new Set(orderedTestFiles)];
    }

    if (selectedIndices.size > 0) {
      testFiles = testFiles.filter((_, index) => selectedIndices.has(index));
    }

    console.log(`[Info] Starting test run with ${testFiles.length} tests. Parallel jobs: ${jobs}`);

    // 3. Execution Loop (First Pass)
    let results = [];
    let currentContext = context;
    let currentBrowser = browser;
    let isRestarting = false;

    const chunkedExec = async (files) => {
        let index = 0;
        const executeNext = async () => {
            while (index < files.length) {
                // Wait for restart to complete if another worker is restarting
                while (isRestarting) await new Promise(r => setTimeout(r, 100));

                const i = index++;
                if (i >= files.length) break;

                const testFile = files[i];

                await test.step(`Test: ${testFile}`, async () => {
                     let page = null;
                     try {
                         // Ensure context exists
                         if (!currentContext && !isRestarting) {
                             // Should not happen if logic is correct, but safe check
                             console.warn("No context available, waiting...");
                             return;
                         }

                         page = await currentContext.newPage();
                         // Run test (Attempt 0)
                         const start = Date.now();
                         const res = await this.runSingleWptTest(page, testFile, i, files.length, 0);
                         res.executionTime = ((Date.now() - start) / 1000).toFixed(2);
                         res.fileName = testFile; // Store filename for retry
                         results.push(res);
                     } catch (e) {
                         const isCriticalError = e.message === 'GPUContextCreationError' ||
                                               e.message === 'HarnessError' ||
                                               e.message.includes('Protocol error') ||
                                               e.message.includes('Target.createTarget') ||
                                               e.message.includes('Target.close') ||
                                               e.message.includes('browserContext.newPage');

                         // Handle Critical Context Errors (GPU, Protocol, Harness, etc.)
                         if (isCriticalError) {
                             let errorType = 'Browser/Protocol Error';
                             if (e.message === 'GPUContextCreationError') errorType = 'GPU Context Creation Failed';
                             else if (e.message === 'HarnessError') errorType = 'Harness Error (Restarting)';

                             console.log(`[Fail] ${errorType} for ${testFile} (${e.message}). Triggering browser restart...`);

                             results.push({
                                 testName: testFile, // Fallback name
                                 fileName: testFile,
                                 suite: 'WPT',
                                 result: 'ERROR',
                                 subcases: {total:0, passed:0, failed:0},
                                 error: errorType
                             });

                             // Acquire lock to restart
                             if (!isRestarting) {
                                 isRestarting = true;
                                 try {
                                     const instance = await this.restartBrowserAndContext(currentBrowser);
                                     currentBrowser = instance.browser || instance.context;
                                     currentContext = instance.context;
                                     this.page = instance.page;
                                     // Update global context reference if possible or just use currentContext in loop
                                     // Note: context passed to runWptTests is local, so we rely on currentContext
                                 } catch (restartError) {
                                     console.error(`[Fail] Fatal error restarting browser: ${restartError.message}`);
                                 } finally {
                                     isRestarting = false;
                                 }
                             }
                         } else {
                             console.error(`Error executing ${testFile}: ${e}`);
                             results.push({
                                 testName: testFile, // Fallback name
                                 fileName: testFile,
                                 suite: 'WPT',
                                 result: 'ERROR',
                                 subcases: {total:0, passed:0, failed:0},
                                 error: e.message
                             });
                         }
                     } finally {
                         if (page && !page.isClosed()) {
                             try { await page.close(); } catch(e) {}
                         }
                     }
                });
            }
        };

        const workers = [];
        for(let j=0; j<Math.min(jobs, files.length); j++) {
            workers.push(executeNext());
        }
        await Promise.all(workers);
    };

    await chunkedExec(testFiles);

    // 4. Retry Logic
    // "all the retries should happen after all the cases run once"
    const failures = results.filter(r => r.result !== 'PASS');

    if (failures.length > 0) {
        console.log(`\n[Warning]  First pass complete. Found ${failures.length} failures. Starting retries...`);
        console.log(`[Info] Closing main browser context to ensure fresh environments for retries.`);

        // Close Phase 1 browser/context to release resources/locks (important for PersistentContext)
        // Use currentContext/currentBrowser in case restarts happened during execution
        try {
           if (currentContext) await currentContext.close();
           if (currentBrowser && currentBrowser !== currentContext) await currentBrowser.close();

           // Also try closing original context if different, just in case
           if (context && context !== currentContext) await context.close();
        } catch(e) {
           console.log(`Ignorable error closing main browser: ${e.message}`);
        }

        for (let i = 0; i < failures.length; i++) {
            const result = failures[i];
            const testFile = result.fileName;
            const maxRetries = 3;
            let attempt = 1;
            // Initialize history with the failure from the first pass
            let retryHistory = [{
                attempt: 0,
                status: result.result,
                passed: result.subcases ? result.subcases.passed : 0,
                failed: result.subcases ? result.subcases.failed : 0,
                total: result.subcases ? result.subcases.total : 0
            }];

            console.log(`\n[Retry] [${i+1}/${failures.length}] Retrying: ${result.testName}`);

            while (attempt <= maxRetries) {
                let retryInstance = null;
                try {
                    // "for each retry, we should launch a new browser context"
                    retryInstance = await this.launchNewBrowser();
                    const retryPage = retryInstance.page;

                    const res = await this.runSingleWptTest(retryPage, testFile, -1, -1, attempt);

                    retryHistory.push({
                        attempt,
                        status: res.result,
                        passed: res.subcases.passed,
                        failed: res.subcases.failed,
                        total: res.subcases.total
                    });

                    // Update result if passed or stabilized
                    if (res.result === 'PASS') {
                         console.log(`[Success] Retry ${attempt} PASSED!`);
                         result.result = 'PASS';
                         result.subcases = res.subcases;
                         result.retryHistory = retryHistory;
                         break; // Stop retrying this case
                    } else {
                         // Check if result is same as previous (using helper from base class)
                         if (this.compareTestResults(result, res)) {
                             console.log(`[Warning]  Retry ${attempt} result matches previous failure. Stopping retries for this case.`);
                             result.retryHistory = retryHistory;
                             break;
                         }
                         // Update result to latest failure
                         result.subcases = res.subcases;
                         // result.error = res.error; // Update error?
                    }

                } catch (e) {
                    console.error(`[Fail] Error during retry ${attempt}: ${e.message}`);
                    retryHistory.push({ attempt, status: 'ERROR', error: e.message });
                } finally {
                    if (retryInstance) {
                        try {
                           if (retryInstance.page && !retryInstance.page.isClosed()) await retryInstance.page.close();
                           if (retryInstance.context) await retryInstance.context.close();
                           if (retryInstance.browser && retryInstance.browser !== retryInstance.context) await retryInstance.browser.close();
                        } catch(e) {}
                    }
                }
                attempt++;
            }
            if (!result.retryHistory) result.retryHistory = retryHistory;
        }
    }

    return results;
  }

  // Removed runTestWithRetry as it's replaced by the retry logic above

  async runSingleWptTest(page, testFile, index, totalFiles, retryCount = 0) {
    const testFileName = testFile.replace('.js', '.html');
    const testUrl = `https://wpt.live/webnn/conformance_tests/${testFileName}?gpu`;
    const testName = testFile.replace('.https.any.js', '').replace('.js', '');

    let logPrefix = `Running test`;
    if (index >= 0 && totalFiles > 0) {
        logPrefix += ` ${index+1}/${totalFiles}`;
    }
    if (retryCount > 0) {
        logPrefix += ` [Retry ${retryCount}]`;
    }
    console.log(`${logPrefix}: ${testName}`);

    try {
        await page.goto(testUrl, { waitUntil: 'networkidle', timeout: 60000 });

        // check if encounter gpu context error or harness error
        const crashError = await page.evaluate(() => {
            const pre = document.evaluate('//*[@id="summary"]/section/pre[1]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (pre && pre.textContent.includes('Error: Unable to create context for gpu variant')) {
                return 'GPUContextCreationError';
            }

            const summarySpan = document.evaluate('//*[@id="summary"]/section/p/span', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (summarySpan && (summarySpan.textContent.includes('Error'))) {
                 return 'HarnessError';
            }
            return null;
       });

       if (crashError) {
            throw new Error(crashError);
       }

        await page.waitForTimeout(3000);

        // Wait for results indicator
        try {
             // Check if .status selector exists first
            const hasStatusSelector = await page.evaluate(() => document.querySelector('.status') !== null);
            if (hasStatusSelector) {
                await page.waitForSelector('.status', { timeout: 60000 });
            } else {
                await page.waitForFunction(() =>
                    document.body.textContent.includes('Pass') ||
                    document.body.textContent.includes('Fail') ||
                    document.body.textContent.includes('Found') ||
                    document.body.textContent.includes('test'),
                    { timeout: 60000 }
                );
            }
        } catch(e) { /* proceed */ }

        await page.waitForTimeout(2000);

        // Parse results with robust logic from original file
        const resData = await page.evaluate(() => {
            const body = document.body.textContent;
            let subcases = { total: 0, passed: 0, failed: 0 };

            const pattern1 = body.match(/Found\s+(\d+)\s+tests?\s*(\d+)\s+Pass\s*(\d+)\s+Fail/i);
            const pattern1AllPass = body.match(/Found\s+(\d+)\s+tests?\s*(\d+)\s+Pass(?!\s*\d+\s+Fail)/i);
            const pattern2 = body.match(/(\d+)\/(\d+)\s+tests?\s+passed/i);
            const pattern3Passed = body.match(/(\d+)\s+passed/i);
            const pattern3Failed = body.match(/(\d+)\s+failed/i);
            const patternSimpleFail = body.match(/(\d+)\s+FAIL/i);
            const patternSimplePass = body.match(/(\d+)\s+PASS/i);

            if (pattern1) {
                subcases.total = parseInt(pattern1[1]);
                subcases.passed = parseInt(pattern1[2]);
                subcases.failed = parseInt(pattern1[3]);
            } else if (pattern1AllPass) {
                 subcases.total = parseInt(pattern1AllPass[1]);
                 subcases.passed = parseInt(pattern1AllPass[2]);
                 subcases.failed = 0;
            } else if (pattern2) {
                subcases.passed = parseInt(pattern2[1]);
                subcases.total = parseInt(pattern2[2]);
                subcases.failed = subcases.total - subcases.passed;
            } else if (pattern3Passed && pattern3Failed) {
                subcases.passed = parseInt(pattern3Passed[1]);
                subcases.failed = parseInt(pattern3Failed[1]);
                subcases.total = subcases.passed + subcases.failed;
            } else if (patternSimpleFail || patternSimplePass) {
                if (patternSimpleFail) subcases.failed = parseInt(patternSimpleFail[1]);
                if (patternSimplePass) subcases.passed = parseInt(patternSimplePass[1]);
                subcases.total = subcases.passed + subcases.failed;
            } else {
                const passCount = (body.match(/\bPASS\b/g) || []).length;
                const failCount = (body.match(/\bFAIL\b/g) || []).length;
                if (passCount + failCount > 0) {
                    subcases.passed = passCount;
                    subcases.failed = failCount;
                    subcases.total = passCount + failCount;
                }
            }

            // If still 0, try fallback guess
            if (subcases.total === 0) {
                const allNumbers = body.match(/\d+/g) || [];
                if (body.toLowerCase().includes('test') && allNumbers.length >= 2) {
                     subcases.total = Math.max(...allNumbers.map(n => parseInt(n)));
                     if (body.toLowerCase().includes('pass')) subcases.passed = subcases.total;
                }
            }

            // Fallback for completion
            if (subcases.total === 0) {
                 const lowerBody = body.toLowerCase();
                 if (lowerBody.includes('complete') || lowerBody.includes('finished')) {
                      subcases.total = 1;
                      if (lowerBody.includes('fail') || lowerBody.includes('error')) subcases.failed = 1;
                      else subcases.passed = 1;
                 }
            }

            let resultStatus = 'UNKNOWN';
            if (subcases.failed > 0) resultStatus = 'FAIL';
            else if (subcases.passed > 0) resultStatus = 'PASS';
            else if (subcases.total > 0 && subcases.passed === subcases.total) resultStatus = 'PASS';
            else if (body.includes('PASS')) { subcases.total=1; subcases.passed=1; resultStatus = 'PASS'; }
            else if (body.includes('FAIL')) { subcases.total=1; subcases.failed=1; resultStatus = 'FAIL'; }

            return { result: resultStatus, subcases };
        });

        console.log(`   ${resData.result}: ${resData.subcases.passed} PASS, ${resData.subcases.failed} FAIL`);

        return {
            testName,
            testUrl,
            suite: 'WPT',
            result: resData.result,
            subcases: resData.subcases,
            executionTime: '0.00'
        };

    } catch (e) {
        return {
            testName,
            suite: 'WPT',
            result: 'ERROR',
            subcases: { total: 0, passed: 0, failed: 0 },
            error: e.message
        };
    }
  }
}

module.exports = { WptRunner };
