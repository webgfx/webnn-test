import { test, expect } from '@playwright/test';

class WebNNTestRunner {
  constructor(page) {
    this.page = page;
    this.epFlag = process.env.EP_FLAG === 'true';
  }

  async restartBrowserAndContext(browserToClose) {
    if (browserToClose) {
      try {
        console.log('🔄 Closing browser before restart...');
        await browserToClose.close();
        console.log('✅ Browser closed');
      } catch (e) {
        console.log(`⚠️ Error closing browser: ${e.message}`);
      }
    }

    // Wait a bit to ensure process is fully gone
    await new Promise(resolve => setTimeout(resolve, 1000));

    if (!this.launchNewBrowser) {
      throw new Error('launchNewBrowser function is not defined');
    }

    console.log('🔄 Launching new browser...');
    const newBrowser = await this.launchNewBrowser();
    console.log('✅ New browser launched');

    console.log('🔄 Creating new context...');
    const newContext = await newBrowser.newContext();
    console.log(`✅ Created fresh browser context (ID: ${newContext._guid || 'N/A'})`);

    return { browser: newBrowser, context: newContext };
  }

  async checkOnnxRuntimeDlls() {
    const { execSync } = require('child_process');
    const path = require('path');

    try {
      console.log('🔍 Checking for ONNX Runtime DLLs in Chrome process...');

      // Construct path to Listdlls64.exe in tools folder
      const toolsPath = path.join(process.cwd(), 'tools', 'Listdlls64.exe');

      // Run Listdlls64.exe -v chrome.exe and filter for onnxruntime*.dll files
      // Note: Using findstr on Windows with pattern matching for .dll files
      const command = `${toolsPath} -v chrome.exe | findstr /i "onnxruntime.*\\.dll"`;

      console.log(`Running command: ${command}`);
      const output = execSync(command, {
        encoding: 'utf8',
        timeout: 600000 // 10 minute timeout
      });

      if (output && output.trim()) {
        // Verify that we actually found .dll files, not just any text containing "onnxruntime"
        const dllLines = output.trim().split('\n').filter(line => line.includes('.dll'));

        if (dllLines.length > 0) {
          console.log('✅ ONNX Runtime DLL files found in Chrome process:');
          console.log(output.trim());
          return { found: true, dlls: output.trim(), dllCount: dllLines.length };
        } else {
          console.log('❌ No ONNX Runtime DLL files found in Chrome process (found text but no .dll files)');
          return { found: false, dlls: '', reason: 'No .dll files in output' };
        }
      } else {
        console.log('❌ No ONNX Runtime DLL files found in Chrome process');
        return { found: false, dlls: '', reason: 'No output from command' };
      }
    } catch (error) {
      console.log(`⚠️ Error checking ONNX Runtime DLLs: ${error.message}`);
      return { found: false, error: error.message };
    }
  }

  async runWptTests(context, browser = null) {
    const suiteStartTime = Date.now();
    console.log('Running WPT tests...');

    // Get specific test cases from suite-specific environment variable
    const testCaseFilter = process.env.WPT_CASE;
    let testCases = [];
    if (testCaseFilter) {
      testCases = testCaseFilter.split(',').map(c => c.trim()).filter(c => c.length > 0);
    }

    // Parse --wpt-range from environment variable (set by test.js wrapper)
    // Usage: --wpt-range 0-9 or --wpt-range 0,1,3-7
    const rangeValue = process.env.WPT_RANGE;
    let selectedIndices = new Set();
    if (rangeValue) {
      const parts = rangeValue.split(',');
      parts.forEach(part => {
        part = part.trim();
        if (part.includes('-')) {
          const rangeParts = part.split('-');
          const start = parseInt(rangeParts[0], 10);
          const end = parseInt(rangeParts[1], 10);
          
          if (!isNaN(start) && !isNaN(end)) {
            for (let i = start; i <= end; i++) {
              selectedIndices.add(i);
            }
          } else {
            console.log(`⚠️ Invalid range format in "${part}"`);
          }
        } else {
          const index = parseInt(part, 10);
          if (!isNaN(index)) {
            selectedIndices.add(index);
          } else {
            console.log(`⚠️ Invalid index format in "${part}"`);
          }
        }
      });
      const sortedIndices = Array.from(selectedIndices).sort((a, b) => a - b);
      console.log(`📊 Range filter: Running test cases with indices ${sortedIndices.join(', ')}`);
    }

    // Get jobs configuration
    const jobs = parseInt(process.env.JOBS || '1', 10);
    const isParallel = jobs > 1;

    if (isParallel) {
      console.log(`Running test cases in parallel with ${jobs} job(s): ${testCases.join(', ')}`);
    } else {
      console.log(`Running specific test cases sequentially: ${testCases.join(', ')}`);
    }

    // Navigate to the WPT conformance tests directory
    await this.page.goto('https://wpt.live/webnn/conformance_tests/');

    // Wait for the page to load and get all test files with class "file"
    await this.page.waitForSelector('.file');

    // Get all test files
    let testFiles = await this.page.$$eval('.file', elements => {
      return elements
        .map(el => {
          const link = el.querySelector('a');
          return link ? link.textContent.trim() : null;
        })
        .filter(name => name && name.endsWith('.js'));
    });

    // Close the discovery page after getting all test files
    console.log('✅ Test discovery complete - closing discovery page...');
    await this.page.close();
    console.log('✅ Discovery page closed');

    // Create a fresh browser context for test execution
    console.log('🔄 Creating fresh browser context for test execution...');

    // Close all remaining pages in the current context
    const discoveryPages = context.pages();
    for (const page of discoveryPages) {
      if (!page.isClosed()) {
        await page.close();
      }
    }

    // Close the discovery context
    await context.close();
    console.log('   ✅ Closed discovery context');

    // Ensure fresh browser for test execution
    if (this.launchNewBrowser && browser) {
      console.log('🔄 Restarting browser for test execution...');
      const result = await this.restartBrowserAndContext(browser);
      browser = result.browser;
      context = result.context;
    } else {
      // Create new context for test execution
      context = await browser.newContext();
      console.log('   ✅ Created fresh browser context for test execution');
      console.log(`   📍 Context ID: ${context._guid || 'N/A'}\n`);
    }

    // Apply test case selection if specified - run cases sequentially
    if (testCases.length > 0) {
      const orderedTestFiles = [];
      testCases.forEach(testCase => {
        const caseFiles = testFiles.filter(testFile => {
          // Extract the base filename without extension
          const baseName = testFile.replace('.https.any.js', '').replace('.js', '');
          // Exact match of the base filename
          return baseName.toLowerCase() === testCase.toLowerCase();
        });
        console.log(`Found ${caseFiles.length} test files for case "${testCase}":`, caseFiles);
        orderedTestFiles.push(...caseFiles);
      });

      // Remove duplicates while preserving order (in case a file matches multiple cases)
      testFiles = [...new Set(orderedTestFiles)];
      if (isParallel) {
        console.log(`Selected ${testFiles.length} test files for parallel execution with ${jobs} job(s): "${testCases.join(', ')}"`);
      } else {
        console.log(`Selected ${testFiles.length} test files in sequential order for cases "${testCases.join(', ')}":`, testFiles);
      }
    } else {
      console.log(`Found ${testFiles.length} test files:`, testFiles);
    }

    // Apply range/index filter if specified (applies after test case selection)
    if (selectedIndices.size > 0) {
      const originalLength = testFiles.length;
      testFiles = testFiles.filter((_, index) => selectedIndices.has(index));
      console.log(`📊 Applied range filter: Selected ${testFiles.length} of ${originalLength} test file(s)`);
      console.log(`   Test files selected:`, testFiles.map((f, i) => `${i}: ${f}`));
    }

    console.log(`\n▶️  Starting fresh test run with ${testFiles.length} test(s)\n`);

    const results = [];
    const testResultsMap = new Map(); // Map testFile to result for retry tracking

    // Unified execution for both parallel and sequential modes
    // Sequential mode (jobs=1) is just a special case where chunk size = 1
    let completedTests = 0;
    const totalTests = testFiles.length;

    const executeTest = async (testFile, index, totalFiles, batchContext) => {
      const testStartTime = Date.now();
      let page = null;

      try {
        // Check if context is still valid before creating page
        try {
          console.log(`🔍 Creating page for ${testFile} using context ID: ${batchContext._guid || 'N/A'}`);
          page = await batchContext.newPage();
        } catch (contextError) {
          console.error(`❌ Failed to create page for ${testFile}: ${contextError.message}`);
          // Return error result if context is closed
          return {
            testName: testFile.replace('.https.any.js', '').replace('.js', ''),
            testUrl: `https://wpt.live/webnn/conformance_tests/${testFile.replace('.js', '.html')}?gpu`,
            testFile: testFile,
            result: 'ERROR',
            errors: [{ text: `Context closed: ${contextError.message}`, selector: 'exception' }],
            fullText: `Exception: Context closed - ${contextError.message}`,
            hasErrors: true,
            details: contextError.stack || contextError.message,
            subcases: { total: 1, passed: 0, failed: 1, details: [] },
            suite: 'wpt',
            executionTime: '0.00'
          };
        }

        // Pass skipRetry=true to prevent immediate retries
        const result = await this.runSingleWptTest(page, testFile, index, totalFiles, 0, batchContext, browser, null, true);

        // Add execution time and testFile to result
        const testEndTime = Date.now();
        const executionTime = ((testEndTime - testStartTime) / 1000).toFixed(2);
        result.executionTime = executionTime;
        result.testFile = testFile;

        // Update progress after each test completes
        completedTests++;
        const percentage = ((completedTests / totalTests) * 100).toFixed(1);
        console.log(`📊 Progress: ${completedTests}/${totalTests} tests completed (${percentage}%) - ${result.testName}: ${executionTime}s`);

        return result;
      } finally {
        // Always close the page after test completes (if it was created)
        if (page && !page.isClosed()) {
          try {
            await page.close();
          } catch (closeError) {
            console.log(`⚠️  Warning: Failed to close page for ${testFile}: ${closeError.message}`);
          }
        }
      }
    };

    // Split tests into chunks based on job count
    const chunks = [];
    for (let i = 0; i < testFiles.length; i += jobs) {
      chunks.push(testFiles.slice(i, i + jobs));
    }

    if (isParallel) {
      console.log(`\n🚀 Starting parallel execution: ${totalTests} tests with ${jobs} job(s)`);
    } else {
      console.log(`\n� Starting sequential execution: ${totalTests} test(s)`);
    }
    console.log(`�📦 Split into ${chunks.length} chunk(s) (${jobs} test(s) per chunk)\n`);

    // Track the current browser context
    let currentBatchContext = context;
    console.log(`📍 Initialized currentBatchContext from context (ID: ${currentBatchContext._guid || 'N/A'})\n`);

    // Execute chunks sequentially, but tests within each chunk in parallel
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex];
      const chunkNum = chunkIndex + 1;

      console.log(`\n📦 Processing chunk ${chunkNum}/${chunks.length} (${chunk.length} test(s))...`);

      const chunkResults = await Promise.all(
        chunk.map((testFile, indexInChunk) => {
          const absoluteIndex = chunks.slice(0, chunkIndex).flat().length + indexInChunk;
          return executeTest(testFile, absoluteIndex, testFiles.length, currentBatchContext);
        })
      );
      results.push(...chunkResults);

      // After batch completes, create a fresh browser context for the NEXT batch
      // (but not after the last batch since there's no next batch)
      if (chunkIndex < chunks.length - 1 && browser) {
        console.log(`\n🔄 Creating fresh browser context for next chunk...`);
        try {
          // Close all pages in the current batch context
          const currentPages = currentBatchContext.pages();
          for (const page of currentPages) {
            if (!page.isClosed()) {
              await page.close();
            }
          }

          // Close the current batch context
          await currentBatchContext.close();
          console.log(`   ✅ Closed batch ${chunkNum} context`);

          // Ensure fresh browser for next batch
          if (this.launchNewBrowser) {
            console.log('🔄 Restarting browser for next batch...');
            const result = await this.restartBrowserAndContext(browser);
            browser = result.browser;
            currentBatchContext = result.context;
          } else {
            // Create new context for next batch
            currentBatchContext = await browser.newContext();
            console.log(`   ✅ Created fresh browser context for batch ${chunkNum + 1}\n`);
          }
        } catch (error) {
          console.log(`   ⚠️ Error recreating context: ${error.message}, continuing with existing context`);
        }
      }
    }

    // Store results in map for retry tracking
    results.forEach(result => {
      testResultsMap.set(result.testFile, result);
    });

    // After all initial tests complete, process retries sequentially
    console.log(`\n\n${'='.repeat(80)}`);
    console.log('📋 INITIAL TEST EXECUTION COMPLETE');
    console.log(`${'='.repeat(80)}\n`);

    // Collect tests that need retry
    const testsNeedingRetry = results.filter(r =>
      r.result === 'ERROR' || r.result === 'UNKNOWN' || r.result === 'FAIL'
    );

    if (testsNeedingRetry.length > 0) {
      console.log(`\n🔄 RETRY PHASE: ${testsNeedingRetry.length} test(s) need retry`);
      console.log(`   ERROR: ${results.filter(r => r.result === 'ERROR').length}`);
      console.log(`   UNKNOWN: ${results.filter(r => r.result === 'UNKNOWN').length}`);
      console.log(`   FAIL: ${results.filter(r => r.result === 'FAIL').length}`);

      // Clean up all pages/contexts from initial test execution before retry phase
      console.log(`\n🧹 Cleaning up browser contexts before retry phase...`);
      try {
        // Note: Discovery page was already closed after getting test files

        // Get all pages in the context and close them
        if (context) {
          const allPages = context.pages();
          console.log(`   Found ${allPages.length} page(s) in context`);
          for (const page of allPages) {
            if (!page.isClosed()) {
              console.log(`   Closing page: ${page.url()}`);
              await page.close();
            }
          }
          console.log(`   ✅ All pages closed`);
        }

        console.log(`✅ Cleanup complete - ready for retry phase\n`);
      } catch (cleanupError) {
        console.log(`⚠️  Warning during cleanup: ${cleanupError.message}`);
        console.log(`   Continuing with retry phase...\n`);
      }

      console.log(`\n🔄 Running retries sequentially with fresh browser contexts...\n`);

      // Process retries sequentially
      for (let i = 0; i < testsNeedingRetry.length; i++) {
        const testResult = testsNeedingRetry[i];
        const testFile = testResult.testFile;
        const testName = testResult.testName;

        console.log(`\n${'─'.repeat(80)}`);
        console.log(`🔄 Retry ${i + 1}/${testsNeedingRetry.length}: ${testName} (was ${testResult.result})`);
        console.log(`${'─'.repeat(80)}\n`);

        // Run retry with fresh context and browser launcher
        const finalResult = await this.runTestWithRetry(
          testFile,
          context,
          browser,
          testResult,
          this.launchNewBrowser // Pass the browser launcher function
        );

        // Update the result in our map and results array
        const resultIndex = results.findIndex(r => r.testFile === testFile);
        if (resultIndex !== -1) {
          results[resultIndex] = finalResult;
        }
        testResultsMap.set(testFile, finalResult);
      }

      console.log(`\n\n${'='.repeat(80)}`);
      console.log('✅ RETRY PHASE COMPLETE');
      console.log(`${'='.repeat(80)}\n`);
    } else {
      console.log(`\n✅ All tests passed on first attempt - no retries needed!\n`);
    }

    // Calculate wall time (actual elapsed time) and sum of individual test times
    const suiteEndTime = Date.now();
    const sessionWallTime = ((suiteEndTime - suiteStartTime) / 1000).toFixed(2);

    const sumOfTestTimes = results.reduce((sum, r) => sum + (parseFloat(r.executionTime) || 0), 0).toFixed(2);

    // Log execution summary
    if (testCases.length > 0) {
      if (isParallel) {
        console.log(`\n✅ Completed parallel execution of cases: ${testCases.join(', ')}`);
      } else {
        console.log(`\n✅ Completed sequential execution of cases: ${testCases.join(' → ')}`);
      }

      console.log(`Total test files executed: ${results.length}`);
      console.log(`⏱️  Wall time: ${sessionWallTime}s`);
      console.log(`⏱️  Sum of individual test times: ${sumOfTestTimes}s`);
      if (isParallel && results.length > 0) {
        const speedup = (parseFloat(sumOfTestTimes) / parseFloat(sessionWallTime)).toFixed(2);
        console.log(`⚡ Parallel speedup: ${speedup}x`);
      }

      // Log individual test times
      if (results.length > 0) {
        console.log(`\n⏱️  Individual test execution times:`);
        results.forEach(result => {
          console.log(`   ${result.testName}: ${result.executionTime}s`);
        });
      }
    }

    return results;
  }

  async runSingleWptTest(page, testFile, index, totalFiles, retryCount = 0, context = null, browser = null, previousResult = null, skipRetry = false) {
    const maxRetries = 20; // Maximum retry attempts for FAIL status (for safety)
    // Note: ERROR and UNKNOWN have no retry limit - they retry until resolved

    // Convert .js to .html and add ?gpu parameter
    const testFileName = testFile.replace('.js', '.html');
    const testUrl = `https://wpt.live/webnn/conformance_tests/${testFileName}?gpu`;

    // Extract clean test name (remove .https.any.html extension)
    const testName = testFile.replace('.https.any.js', '').replace('.js', '');

    const retryPrefix = retryCount > 0 ? `[Retry ${retryCount}] ` : '';
    console.log(`${retryPrefix}Running test: ${testName}`);

    try {
      // Capture console errors
      const consoleErrors = [];
      page.on('console', msg => {
        if (msg.type() === 'error') {
          consoleErrors.push(`Console Error: ${msg.text()}`);
        }
      });

      // Capture page errors
      const pageErrors = [];
      page.on('pageerror', error => {
        pageErrors.push(`Page Error: ${error.message}`);
      });

      // Navigate to the test
      await page.goto(testUrl, { waitUntil: 'networkidle' });

      // Wait for test results (WPT tests typically show results in the page)
      // First wait for initial load, then wait for tests to complete
      await page.waitForTimeout(3000);

      // Wait for test completion indicators with longer timeout
      // Use a more flexible approach that doesn't create failed test steps
      try {
        // Check if .status selector exists first (non-blocking)
        const hasStatusSelector = await page.evaluate(() => {
          return document.querySelector('.status') !== null;
        });

        if (hasStatusSelector) {
          await page.waitForSelector('.status', { timeout: 120000 });
        } else {
          // Fall back to waiting for text indicators
          await page.waitForFunction(() =>
            document.body.textContent.includes('Pass') ||
            document.body.textContent.includes('Fail') ||
            document.body.textContent.includes('Found') ||
            document.body.textContent.includes('test'),
            { timeout: 120000 }
          );
        }
      } catch (error) {
        // Silently proceed - this is expected for some test pages
        console.log(`⏭️ Proceeding with content analysis (${testName})`);
      }

      // Additional wait for test results to stabilize
      await page.waitForTimeout(2000);

      // Extract detailed page content and parse results with enhanced debugging
      const testResult = await page.evaluate(() => {
          const body = document.body.textContent;
          const bodyHTML = document.body.innerHTML;

          // Debug: capture page content for analysis
          const debugInfo = {
            title: document.title,
            bodyLength: body.length,
            bodyPreview: body.substring(0, 500),
            hasResults: body.includes('Pass') || body.includes('Fail'),
            hasFoundText: body.includes('Found'),
            hasTestsText: body.includes('tests')
          };

          // Parse WPT subcases with enhanced patterns
          const subcases = {
            total: 0,
            passed: 0,
            failed: 0,
            details: []
          };

          // Enhanced pattern matching for different WPT formats
          // Pattern 1: "Found X tests Y Pass Z Fail" (with or without spaces)
          const pattern1 = body.match(/Found\s+(\d+)\s+tests?\s*(\d+)\s+Pass\s*(\d+)\s+Fail/i);
          const pattern1AllPass = body.match(/Found\s+(\d+)\s+tests?\s*(\d+)\s+Pass(?!\s*\d+\s+Fail)/i);

          // Pattern 2: "X/Y tests passed"
          const pattern2 = body.match(/(\d+)\/(\d+)\s+tests?\s+passed/i);

          // Pattern 3: "X passed, Y failed"
          const pattern3Passed = body.match(/(\d+)\s+passed/i);
          const pattern3Failed = body.match(/(\d+)\s+failed/i);

          // Pattern 4: Count PASS/FAIL text occurrences
          const passCount = (body.match(/\bPASS\b/g) || []).length;
          const failCount = (body.match(/\bFAIL\b/g) || []).length;

          // Pattern 5: Look for "Harness" status and subtest results
          const harnessPattern = body.match(/Harness:\s*(\w+)/i);

          if (pattern1) {
            subcases.total = parseInt(pattern1[1]);
            subcases.passed = parseInt(pattern1[2]);
            subcases.failed = parseInt(pattern1[3]);
            debugInfo.parseMethod = 'pattern1_with_fail';
          } else if (pattern1AllPass) {
            subcases.total = parseInt(pattern1AllPass[1]);
            subcases.passed = parseInt(pattern1AllPass[2]);
            subcases.failed = 0;
            debugInfo.parseMethod = 'pattern1_all_pass';
          } else if (pattern2) {
            subcases.passed = parseInt(pattern2[1]);
            subcases.total = parseInt(pattern2[2]);
            subcases.failed = subcases.total - subcases.passed;
            debugInfo.parseMethod = 'pattern2_fraction';
          } else if (pattern3Passed && pattern3Failed) {
            subcases.passed = parseInt(pattern3Passed[1]);
            subcases.failed = parseInt(pattern3Failed[1]);
            subcases.total = subcases.passed + subcases.failed;
            debugInfo.parseMethod = 'pattern3_separate_counts';
          } else if (passCount > 0 || failCount > 0) {
            subcases.passed = passCount;
            subcases.failed = failCount;
            subcases.total = passCount + failCount;
            debugInfo.parseMethod = 'pattern4_text_count';
          } else {
            // Look for HTML elements with status classes
            const statusElements = document.querySelectorAll('[class*="pass"], [class*="fail"], .status');
            let elementPassCount = 0;
            let elementFailCount = 0;

            statusElements.forEach(el => {
              const className = el.className.toLowerCase();
              const text = el.textContent.toLowerCase();

              if (className.includes('pass') || text.includes('pass')) {
                elementPassCount++;
              } else if (className.includes('fail') || text.includes('fail')) {
                elementFailCount++;
              }
            });

            if (elementPassCount > 0 || elementFailCount > 0) {
              subcases.passed = elementPassCount;
              subcases.failed = elementFailCount;
              subcases.total = elementPassCount + elementFailCount;
              debugInfo.parseMethod = 'element_counting';
            }
          }

          // If still no results, try to extract from entire page content with relaxed patterns
          if (subcases.total === 0) {
            // Look for any numbers that might indicate test results
            const allNumbers = body.match(/\d+/g) || [];
            if (allNumbers.length > 0) {
              // Try to find contextual clues
              const testContext = body.toLowerCase();
              if (testContext.includes('test') && allNumbers.length >= 2) {
                // Make educated guess based on common patterns
                subcases.total = Math.max(...allNumbers.map(n => parseInt(n)));
                debugInfo.parseMethod = 'fallback_guess';

                // Try to determine pass/fail split
                if (testContext.includes('all') && testContext.includes('pass')) {
                  subcases.passed = subcases.total;
                  subcases.failed = 0;
                } else {
                  // Default to unknown breakdown
                  subcases.passed = 0;
                  subcases.failed = 0;
                }
              }
            }
          }

          return {
            body: body,
            bodyHTML: bodyHTML,
            subcases: subcases,
            debug: debugInfo
          };
        });

        // Debug output for troubleshooting
        console.log(`🔍 Debug info for ${testName}:`);
        console.log(`   Parse method: ${testResult.debug.parseMethod || 'none'}`);
        console.log(`   Page title: ${testResult.debug.title}`);
        console.log(`   Body length: ${testResult.debug.bodyLength}`);
        console.log(`   Has results: ${testResult.debug.hasResults}`);
        console.log(`   Body preview: ${testResult.debug.bodyPreview.replace(/\s+/g, ' ')}`);

        // Use the parsed values with validation
        if (testResult.subcases.total > 0 || (testResult.subcases.passed > 0 || testResult.subcases.failed > 0)) {
          console.log(`📊 Parsed results: ${testResult.subcases.total} total, ${testResult.subcases.passed} passed, ${testResult.subcases.failed} failed`);

          // Validate and correct totals if needed
          if (testResult.subcases.total === 0 && (testResult.subcases.passed > 0 || testResult.subcases.failed > 0)) {
            testResult.subcases.total = testResult.subcases.passed + testResult.subcases.failed;
            console.log(`   Corrected total to: ${testResult.subcases.total}`);
          }
        } else {
          console.log(`⚠️ No test results found using standard patterns`);
          console.log(`   Will attempt fallback parsing...`);

          // Enhanced fallback: try to determine if test completed successfully
          const body = testResult.body.toLowerCase();

          // Check for completion indicators
          if (body.includes('complete') || body.includes('finished') || body.includes('done')) {
            if (body.includes('error') || body.includes('fail') || body.includes('exception')) {
              testResult.subcases = { total: 1, passed: 0, failed: 1, details: [] };
              console.log(`   Fallback: detected completion with errors`);
            } else if (body.includes('pass') || body.includes('success') || body.includes('ok')) {
              testResult.subcases = { total: 1, passed: 1, failed: 0, details: [] };
              console.log(`   Fallback: detected successful completion`);
            } else {
              testResult.subcases = { total: 1, passed: 0, failed: 0, details: [] };
              console.log(`   Fallback: detected completion but unknown status`);
            }
          } else {
            // No clear completion, analyze content for any results
            if (testResult.debug.bodyLength > 100) { // Page has content
              testResult.subcases = { total: 1, passed: 0, failed: 0, details: [] };
              console.log(`   Fallback: page loaded but no clear results`);
            } else {
              testResult.subcases = { total: 1, passed: 0, failed: 1, details: [] };
              console.log(`   Fallback: minimal content, likely load error`);
            }
          }
        }

        // Determine overall status based on subcases
        let overallStatus = 'UNKNOWN';
        const body = testResult.body;
        const bodyHTML = testResult.bodyHTML;

        // If still no subcases detected, treat as single test
        if (testResult.subcases.total === 0) {
          testResult.subcases.total = 1;
          if (body.includes('PASS') || body.includes('All tests passed')) {
            testResult.subcases.passed = 1;
            testResult.subcases.failed = 0;
          } else if (body.includes('FAIL') || body.includes('Error') || body.includes('failed') ||
                     body.includes('AssertionError') || body.includes('TypeError') ||
                     body.includes('ReferenceError') || bodyHTML.includes('class="fail"')) {
            testResult.subcases.passed = 0;
            testResult.subcases.failed = 1;
          } else {
            // Unknown state
            testResult.subcases.passed = 0;
            testResult.subcases.failed = 0;
          }
        }

        // Determine overall status
        if (testResult.subcases.failed === 0 && testResult.subcases.passed > 0) {
          overallStatus = 'PASS';
        } else if (testResult.subcases.failed > 0) {
          overallStatus = 'FAIL';
        }

        // Get detailed error information
        const errorDetails = await page.evaluate(() => {
          const errors = [];

          // Look for error elements with various selectors
          const errorSelectors = [
            '.error', '.fail', '[class*="error"]', '[class*="fail"]',
            '.test-fail', '.assertion-error', 'pre.error',
            // WPT specific selectors
            '.status.fail', '.subtest.fail', '.message'
          ];

          errorSelectors.forEach(selector => {
            const elements = document.querySelectorAll(selector);
            elements.forEach(el => {
              if (el.textContent.trim()) {
                errors.push({
                  selector: selector,
                  text: el.textContent.trim(),
                  html: el.innerHTML
                });
              }
            });
          });

          // Also capture console errors if available
          const consoleErrors = [];
          // Try to get console errors from the page (if available)
          if (window.console && window.console.error) {
            // This won't capture previous errors, but we can try other methods
          }

          return {
            errors: errors,
            fullPageText: document.body.textContent,
            hasErrors: errors.length > 0 ||
                      document.body.textContent.includes('Error') ||
                      document.body.textContent.includes('FAIL') ||
                      document.body.textContent.includes('failed')
          };
        });

        // Combine all error sources
        const allErrors = [
          ...errorDetails.errors,
          ...consoleErrors.map(err => ({ text: err, selector: 'console' })),
          ...pageErrors.map(err => ({ text: err, selector: 'page' }))
        ];

        const result = {
          testName,
          testUrl,
          result: overallStatus,
          errors: allErrors,
          fullText: errorDetails.fullPageText,
          hasErrors: errorDetails.hasErrors || consoleErrors.length > 0 || pageErrors.length > 0,
          details: body,
          consoleErrors,
          pageErrors,
          subcases: testResult.subcases,
          totalTestsFromPage: testResult.subcases.total,
          suite: 'wpt'
        };

        // Enhanced console output with breakdown
        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`Test ${testName}: ${overallStatus}`);
        console.log(`  📋 Total tests (from page): ${testResult.subcases.total}`);
        if (testResult.subcases.total > 0) {
          console.log(`  ✅ Passed: ${testResult.subcases.passed}`);
          console.log(`  ❌ Failed: ${testResult.subcases.failed}`);
          console.log(`  📊 Total: ${testResult.subcases.total}`);
          console.log(`  📈 Success Rate: ${((testResult.subcases.passed/testResult.subcases.total)*100).toFixed(1)}%`);
        }
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
        if (errorDetails.hasErrors) {
          console.log('❌ ERRORS DETECTED:');
          console.log('Full page content:', errorDetails.fullPageText.substring(0, 500) + '...');
          if (errorDetails.errors.length > 0) {
            errorDetails.errors.forEach((error, index) => {
              console.log(`  Error ${index + 1} (${error.selector}): ${error.text}`);
            });
          }
        }

        // Helper function to check if two failure results are identical
        const areFailuresIdentical = (result1, result2) => {
          if (!result1 || !result2) return false;
          if (result1.result !== result2.result) return false;

          // Compare subcase counts
          const sc1 = result1.subcases;
          const sc2 = result2.subcases;
          if (sc1.total !== sc2.total || sc1.passed !== sc2.passed || sc1.failed !== sc2.failed) {
            return false;
          }

          return true;
        };

        // If skipRetry is true, just return the result without retrying
        // This is used during initial test execution - retries happen later in a separate phase
        if (skipRetry) {
          if (overallStatus !== 'PASS') {
            console.log(`⏭️  Test will be retried in sequential retry phase after all tests complete\n`);
          }
          return result;
        }

        // Check if we should retry (this code path is only used during retry phase)
        // Retry conditions:
        // 1. UNKNOWN or ERROR status -> ALWAYS retry (no limit) with fresh browser context
        // 2. FAIL status -> retry until we see 2 consecutive identical failures (up to maxRetries)
        const shouldRetry = (
          overallStatus === 'UNKNOWN' ||
          overallStatus === 'ERROR' ||
          (overallStatus === 'FAIL' && retryCount < maxRetries && !areFailuresIdentical(previousResult, result))
        );

        if (shouldRetry) {
          if (overallStatus === 'UNKNOWN' || overallStatus === 'ERROR') {
            console.log(`\n⚠️ Test ${testName} returned ${overallStatus} status (retry ${retryCount + 1})`);
            console.log(`🔄 ${overallStatus} results always retry - creating fresh browser context...\n`);
          } else if (overallStatus === 'FAIL' && previousResult && previousResult.result === 'FAIL') {
            // Check if this is the second consecutive identical failure
            if (areFailuresIdentical(previousResult, result)) {
              console.log(`\n✓ Test ${testName} has 2 consecutive identical failures - accepting result`);
              return result;
            }
            console.log(`\n⚠️ Test ${testName} FAILED but result differs from previous failure`);
            console.log(`   Previous: ${previousResult.subcases.passed}/${previousResult.subcases.total} passed`);
            console.log(`   Current:  ${result.subcases.passed}/${result.subcases.total} passed`);
            console.log(`🔄 Retrying to confirm failure pattern (attempt ${retryCount + 1})...\n`);
          } else if (overallStatus === 'FAIL') {
            console.log(`\n⚠️ Test ${testName} FAILED (retry ${retryCount + 1})`);
            console.log(`🔄 Retrying to confirm failure...\n`);
          }

          try {
            // Close current page first
            if (!page.isClosed()) {
              await page.close();
            }

            // Create a completely new context for retry
            let retryContext, retryPage, newBrowser;
            
            // Determine browser to close/restart
            let browserToRestart = browser;
            if (!browserToRestart && context) {
               browserToRestart = context.browser();
            }

            if (browserToRestart) {
               // Unified path: Restart browser to ensure clean state
               console.log('🔄 Restarting browser for retry...');
               try {
                   const newEnv = await this.restartBrowserAndContext(browserToRestart);
                   newBrowser = newEnv.browser;
                   retryContext = newEnv.context;
                   retryPage = newEnv.page;
               } catch (e) {
                   console.log(`❌ Failed to restart browser: ${e.message}`);
                   return result;
               }

               // IMPORTANT: Pass newBrowser to retry
               const retryResult = await this.runSingleWptTest(retryPage, testFile, index, totalFiles, retryCount + 1, retryContext, newBrowser, result);
               
               // Clean up the temporary browser
               try {
                  if (newBrowser) {
                      await newBrowser.close();
                  }
               } catch (cleanupError) {
                  console.log(`⚠️ Cleanup warning: ${cleanupError.message}`);
               }

               return retryResult;
            } else if (context) {
               // Fallback if no browser instance available
               try {
                  retryPage = await context.newPage();
                  console.log('✅ Created new page from existing context for retry (fallback)');
                  const retryResult = await this.runSingleWptTest(retryPage, testFile, index, totalFiles, retryCount + 1, context, null, result);
                  if (retryPage && !retryPage.isClosed()) await retryPage.close();
                  return retryResult;
               } catch (e) {
                  console.log(`❌ Fallback retry failed: ${e.message}`);
                  return result;
               }
            } else {
                console.log('⚠️ No browser/context available for retry, skipping...');
                return result;
            }
          } catch (retryError) {
            console.error(`❌ Error during retry: ${retryError.message}`);
            // Return the original result if retry fails
            return result;
          }
        }

        return result;

      } catch (error) {
        console.error(`❌ ERROR running test ${testName}:`, error.message);
        console.error('Stack trace:', error.stack);

        const errorResult = {
          testName,
          testUrl,
          result: 'ERROR',
          errors: [{ text: error.message, selector: 'exception' }],
          fullText: `Exception: ${error.message}`,
          hasErrors: true,
          details: error.stack,
          subcases: { total: 1, passed: 0, failed: 1, details: [] },
          suite: 'wpt'
        };

        // If skipRetry is true, just return the error result
        // This is used during initial test execution - retries happen later in a separate phase
        if (skipRetry) {
          console.log(`⏭️  ERROR test will be retried in sequential retry phase after all tests complete\n`);
          return errorResult;
        }

        // Check if we should retry on ERROR (this code path is only used during retry phase)
        // ERROR always retries (no limit) to ensure clean resolution
        console.log(`\n⚠️ Test ${testName} encountered an ERROR (retry ${retryCount + 1})`);
        console.log(`🔄 ERROR results always retry - creating fresh browser context...\n`);

        try {
          // Close current page if it's still open
          if (!page.isClosed()) {
            await page.close();
          }

          // Create a completely new context for retry
          let retryContext, retryPage, newBrowser;
          
          // Determine browser to close/restart
          let browserToRestart = browser;
          if (!browserToRestart && context) {
             browserToRestart = context.browser();
          }

          if (browserToRestart) {
             // Unified path: Restart browser to ensure clean state
             console.log('🔄 Restarting browser for ERROR retry...');
             try {
                 const newEnv = await this.restartBrowserAndContext(browserToRestart);
                 newBrowser = newEnv.browser;
                 retryContext = newEnv.context;
                 retryPage = newEnv.page;
             } catch (e) {
                 console.log(`❌ Failed to restart browser: ${e.message}`);
                 return errorResult;
             }

             // IMPORTANT: Pass newBrowser to retry
             const retryResult = await this.runSingleWptTest(retryPage, testFile, index, totalFiles, retryCount + 1, retryContext, newBrowser, errorResult);
             
             // Clean up the temporary browser
             try {
                if (newBrowser) {
                    await newBrowser.close();
                }
             } catch (cleanupError) {
                console.log(`⚠️ Cleanup warning: ${cleanupError.message}`);
             }

             return retryResult;
          } else if (context) {
             // Fallback if no browser instance available (should be rare)
             try {
                retryPage = await context.newPage();
                console.log('✅ Created new page from existing context for retry (fallback)');
                const retryResult = await this.runSingleWptTest(retryPage, testFile, index, totalFiles, retryCount + 1, context, null, errorResult);
                if (retryPage && !retryPage.isClosed()) await retryPage.close();
                return retryResult;
             } catch (e) {
                console.log(`❌ Fallback retry failed: ${e.message}`);
                return errorResult;
             }
          } else {
              console.log('⚠️ No browser/context available for retry, skipping...');
              return errorResult;
          }
          } catch (retryError) {
            console.error(`❌ Error during retry: ${retryError.message}`);
            // Return the original error result if retry fails
            return errorResult;
          }

        return errorResult;
      }
  }

  async runTestWithRetry(testFile, context, browser, previousResult, launchNewBrowser = null) {
    const maxRetries = 20; // Maximum retry attempts for FAIL status
    const maxBrowserClosedAttempts = 3; // Maximum attempts when browser is closed
    const testName = testFile.replace('.https.any.js', '').replace('.js', '');

    let retryCount = 0;
    let currentResult = previousResult;
    let previousRetryResult = null;
    let browserClosedAttempts = 0; // Track consecutive browser closed errors
    let currentBrowser = browser; // Track current browser instance
    let currentContext = context; // Track current context instance

    // Track retry history for reporting
    const retryHistory = [{
      attemptNumber: 0,
      status: previousResult.result,
      passed: previousResult.subcases.passed,
      failed: previousResult.subcases.failed,
      total: previousResult.subcases.total
    }];

    // Helper function to check if two results are identical (works for both PASS and FAIL)
    const areResultsIdentical = (result1, result2) => {
      if (!result1 || !result2) return false;
      if (result1.result !== result2.result) return false;

      // Compare subcase counts
      const sc1 = result1.subcases;
      const sc2 = result2.subcases;
      if (sc1.total !== sc2.total || sc1.passed !== sc2.passed || sc1.failed !== sc2.failed) {
        return false;
      }

      return true;
    };

    // Helper function to launch a new browser instance
    const tryLaunchNewBrowser = async () => {
      if (!launchNewBrowser || typeof launchNewBrowser !== 'function') {
        return null;
      }

      try {
        console.log(`🔄 Attempting to launch a new browser instance...`);
        const newBrowserInstance = await launchNewBrowser();
        console.log(`✅ Successfully launched new browser instance`);
        return newBrowserInstance;
      } catch (launchError) {
        console.error(`❌ Failed to launch new browser: ${launchError.message}`);
        return null;
      }
    };

    try {
      while (true) {
        retryCount++;

        // Check if we've hit the browser closed limit
      if (browserClosedAttempts >= maxBrowserClosedAttempts) {
        console.log(`\n❌ Browser has been closed - cannot retry further (attempted ${browserClosedAttempts} times)`);
        console.log(`⏭️  Test will be retried on next test run\n`);
        break;
      }

      // Determine if we should continue retrying
      // Retry conditions:
      // 1. UNKNOWN or ERROR status -> ALWAYS retry (no limit)
      // 2. FAIL status -> retry until 2 consecutive identical failures (up to maxRetries)
      // 3. PASS status -> retry until 2 consecutive identical passes (to ensure stability)
      const shouldContinue = (
        currentResult.result === 'UNKNOWN' ||
        currentResult.result === 'ERROR' ||
        (currentResult.result === 'FAIL' && retryCount <= maxRetries && !areResultsIdentical(previousRetryResult, currentResult)) ||
        (currentResult.result === 'PASS' && !areResultsIdentical(previousRetryResult, currentResult))
      );

      if (!shouldContinue) {
        if (currentResult.result === 'PASS' && areResultsIdentical(previousRetryResult, currentResult)) {
          console.log(`\n✓ Test ${testName} has 2 consecutive identical PASS results - accepting as stable\n`);
        } else if (currentResult.result === 'FAIL' && areResultsIdentical(previousRetryResult, currentResult)) {
          console.log(`\n✓ Test ${testName} has 2 consecutive identical failures - accepting result\n`);
        } else if (currentResult.result === 'FAIL' && retryCount > maxRetries) {
          console.log(`\n⚠️ Test ${testName} reached maximum retry limit (${maxRetries}) - accepting current FAIL result\n`);
        }
        break;
      }

      // Ensure fresh browser for retry
      let retryContext, retryPage;
      const testStartTime = Date.now();

      if (launchNewBrowser) {
        // Determine browser to close
        let browserToClose = currentBrowser;
        if (!browserToClose && currentContext) {
          browserToClose = currentContext.browser();
        }
        if (!browserToClose) {
          browserToClose = browser;
        }

        try {
          const result = await this.restartBrowserAndContext(browserToClose);
          currentBrowser = result.browser;
          retryContext = result.context;
          currentContext = retryContext;
        } catch (e) {
          console.log(`❌ Failed to restart browser: ${e.message}`);
          break;
        }
      } else {
        // Create fresh browser context for retry
        try {
          // Get browser instance (use current tracked browser)
          let browserInstance = currentBrowser || (currentContext ? currentContext.browser() : null);

          if (!browserInstance) {
            console.log(`❌ No browser instance available for retry`);
            break;
          }

          // Check if browser is connected before trying to create context
          if (browserInstance && !browserInstance.isConnected()) {
            console.log(`❌ Browser is no longer connected - attempting to restart...`);
            browserClosedAttempts++;
            console.log(`⏳ Browser closed attempt ${browserClosedAttempts}/${maxBrowserClosedAttempts}`);

            // Try to launch a new browser
            const newBrowser = await tryLaunchNewBrowser();
            if (newBrowser && newBrowser.isConnected()) {
              console.log(`✅ Successfully restarted browser - continuing with retries`);
              currentBrowser = newBrowser;
              browserInstance = newBrowser;
              browserClosedAttempts = 0; // Reset counter after successful restart
            } else {
              if (browserClosedAttempts >= maxBrowserClosedAttempts) {
                continue; // Will break in next iteration
              }
              await new Promise(resolve => setTimeout(resolve, 2000));
              continue;
            }
          }

          // Create fresh context
          retryContext = await browserInstance.newContext();
          console.log(`✅ Created fresh browser context for retry attempt ${retryCount}`);
        } catch (error) {
          console.error(`❌ Error creating context: ${error.message}`);
          break;
        }
      }

      try {
        retryPage = await retryContext.newPage();

        // Reset browser closed counter on success
        browserClosedAttempts = 0;

        // Run the test without further recursive retries (skipRetry=false for this dedicated retry phase)
        const retryResult = await this.runSingleWptTest(
          retryPage,
          testFile,
          0,
          1,
          retryCount,
          retryContext,
          currentBrowser || browser,
          currentResult,
          false // Allow retries within this call
        );

        // Check if we should pause for this test case (configurable via --pause command line switch)
        // Usage: node src/test.js --suite wpt --pause abs  OR  --pause "abs,add,concat"
        // Parse --pause from environment variable (set by test.js wrapper)
        const pauseCase = process.env.PAUSE_CASE;

        if (pauseCase) {
          const pauseCases = pauseCase.split(',').map(c => c.trim().toLowerCase()).filter(c => c.length > 0);
          const shouldPause = pauseCases.includes(testName.toLowerCase());

          if (shouldPause) {
            console.log(`\n🛑 PAUSING for '${testName}' test case inspection...`);
            console.log(`   ✅ Test has been executed`);
            console.log(`   ✅ Browser context is still alive`);
            console.log(`   ✅ Test page is still open for inspection`);
            console.log(`   📊 Test status: ${retryResult.result}`);
            console.log(`   📊 Subcases: ${retryResult.subcases.passed}/${retryResult.subcases.total} passed, ${retryResult.subcases.failed} failed`);
            console.log(`   🌐 Test URL: ${retryResult.testUrl}`);
            console.log(`\n   🔍 You can now inspect the browser and test page!`);
            console.log(`   ⚠️  ALL TESTS STOPPED - Browser will remain open indefinitely.`);
            console.log(`   Press Ctrl+C to exit when ready.\n`);

            // Wait indefinitely - user must manually stop the process
            // This keeps the browser page and context alive for inspection
            await new Promise(() => {}); // This promise never resolves
          }
        }

        // Add execution time
        const testEndTime = Date.now();
        const executionTime = ((testEndTime - testStartTime) / 1000).toFixed(2);
        retryResult.executionTime = executionTime;
        retryResult.testFile = testFile;

        // Update for next iteration
        previousRetryResult = currentResult;
        currentResult = retryResult;

        // Record retry attempt in history
        retryHistory.push({
          attemptNumber: retryCount,
          status: retryResult.result,
          passed: retryResult.subcases.passed,
          failed: retryResult.subcases.failed,
          total: retryResult.subcases.total
        });

        // Clean up
        try {
          if (retryPage && !retryPage.isClosed()) {
            await retryPage.close();
          }
          await retryContext.close();
        } catch (cleanupError) {
          console.log(`⚠️ Cleanup warning: ${cleanupError.message}`);
        }

        // Check if we should continue based on result
        if (currentResult.result === 'PASS') {
          // For PASS, we need 2 consecutive identical passes
          if (previousRetryResult && areResultsIdentical(previousRetryResult, currentResult)) {
            console.log(`\n✅ Test ${testName} PASSED with 2 consecutive identical results on retry attempt ${retryCount}\n`);
            break;
          } else if (retryCount === 1) {
            console.log(`\n✅ Test ${testName} PASSED on retry attempt ${retryCount} - will retry once more to confirm stability\n`);
          } else {
            console.log(`\n✅ Test ${testName} PASSED on retry attempt ${retryCount} - results differ from previous, will retry to confirm\n`);
          }
        }

      } catch (error) {
        console.error(`❌ Error during retry attempt ${retryCount}: ${error.message}`);

        // Check if error is due to browser being closed
        if (error.message.includes('Target page, context or browser has been closed') ||
            error.message.includes('browser.newContext') ||
            error.message.includes('Browser closed')) {
          browserClosedAttempts++;
          console.log(`⚠️  Browser closed error detected (attempt ${browserClosedAttempts}/${maxBrowserClosedAttempts})`);
        }

        // Clean up on error
        try {
          if (retryPage && !retryPage.isClosed()) {
            await retryPage.close();
          }
          if (retryContext) {
            await retryContext.close();
          }
        } catch (cleanupError) {
          console.log(`⚠️ Cleanup warning: ${cleanupError.message}`);
        }

        // If retry itself failed, keep the current result and try again (for ERROR/UNKNOWN)
        if (currentResult.result === 'ERROR' || currentResult.result === 'UNKNOWN') {
          // If browser is closed, don't wait as long
          if (browserClosedAttempts >= maxBrowserClosedAttempts) {
            continue; // Will break in next iteration
          }
          console.log(`⏳ Waiting 2 seconds before next retry attempt...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        } else {
          // For FAIL, if retry mechanism failed, return current result
          break;
        }
      }
    }

    // Add retry history to final result for reporting
    currentResult.retryHistory = retryHistory;

    // Log retry summary if there were retries
    if (retryHistory.length > 1) {
      console.log(`\n📊 Retry Summary for ${testName}:`);
      retryHistory.forEach((attempt, index) => {
        const prefix = index === 0 ? 'Initial' : `Retry ${index}`;
        console.log(`   ${prefix}: ${attempt.status} (${attempt.passed}/${attempt.total} passed, ${attempt.failed} failed)`);
      });
      console.log('');
    }

    return currentResult;
    } finally {
      // Ensure the browser created for retry is closed to prevent leaks
      if (launchNewBrowser && currentBrowser && currentBrowser !== browser) {
        try {
          console.log('🧹 Closing retry browser instance...');
          await currentBrowser.close();
          console.log('✅ Retry browser closed');
        } catch (e) {
          console.log(`⚠️ Error closing retry browser: ${e.message}`);
        }
      }
    }
  }  async runSamplesTests() {
    console.log('🚀 Running SAMPLE suite...');
    console.log('Running sample tests...');

    // Get specific test cases from suite-specific environment variable
    const testCaseFilter = process.env.SAMPLE_CASE;
    let testCases = [];

    if (testCaseFilter) {
      testCases = testCaseFilter.split(',').map(c => c.trim()).filter(c => c.length > 0);
      console.log(`Running specific sample test cases: ${testCases.join(', ')}`);
    } else {
      // Default: run all sample test cases
      testCases = ['image-classification'];
      console.log('Running all sample test cases');
    }

    const results = [];

    for (const testCase of testCases) {
      try {
        switch (testCase) {
          case 'image-classification':
            await this.runSamplesImageClassification(results);
            break;
          default:
            console.log(`⚠️ Unknown sample test case: ${testCase}`);
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
      } catch (error) {
        console.error(`❌ Error running sample test case ${testCase}:`, error.message);
        results.push({
          testName: `Sample: ${testCase}`,
          testUrl: '',
          result: 'ERROR',
          errors: [{ text: error.message, selector: 'exception' }],
          fullText: `Exception: ${error.message}`,
          hasErrors: true,
          details: error.stack,
          subcases: { total: 1, passed: 0, failed: 1, details: [] },
          suite: 'sample'
        });
      }
    }

    console.log(`\n✅ Completed sample test execution`);
    console.log(`Total sample tests executed: ${results.length}`);

    return results;
  }

  async runSamplesImageClassification(results) {
    const testName = 'EfficientNet Image Classification';
    const testUrl = 'https://webmachinelearning.github.io/webnn-samples/image_classification/';

    try {
      console.log(`Running sample test: ${testName}`);

      // Navigate to the sample page
      await this.page.goto(testUrl, { waitUntil: 'networkidle' });

      // Wait for the page to load
      await this.page.waitForTimeout(3000);

      console.log('Configuring WebNN settings...');

      // Set backend to "WebNN (GPU)" by clicking the second label in backendBtns
      try {
        // First, check what backend options are available
        const backendLabels = await this.page.$$eval('#backendBtns label', labels =>
          labels.map((label, index) => ({
            index: index,
            text: label.textContent.trim(),
            value: label.getAttribute('for') || label.querySelector('input')?.value
          }))
        );
        console.log('Available backend labels:', backendLabels);

        // Click the second label (index 1) in the backendBtns div
        const secondLabel = await this.page.$('#backendBtns label:nth-child(2)');
        if (secondLabel) {
          await secondLabel.click();
          console.log('Clicked second backend label (WebNN GPU)');

          // Verify selection by checking which radio button is selected
          const selectedBackend = await this.page.$eval('#backendBtns input:checked', input => ({
            value: input.value,
            id: input.id,
            nextSibling: input.nextElementSibling?.textContent?.trim()
          }));
          console.log('Selected backend:', selectedBackend);

        } else {
          throw new Error('Could not find second label in backendBtns');
        }

      } catch (error) {
        console.error('Backend selection error:', error.message);
        throw error;
      }

      await this.page.waitForTimeout(500);

      // Set data type to Float16 by clicking the second label in dataTypeBtns
      try {
        // Check what data type options are available
        const dataTypeLabels = await this.page.$$eval('#dataTypeBtns label', labels =>
          labels.map((label, index) => ({
            index: index,
            text: label.textContent.trim(),
            value: label.getAttribute('for') || label.querySelector('input')?.value
          }))
        );
        console.log('Available data type labels:', dataTypeLabels);

        // Click the second label (index 1) in the dataTypeBtns div
        const secondDataTypeLabel = await this.page.$('#dataTypeBtns label:nth-child(2)');
        if (secondDataTypeLabel) {
          await secondDataTypeLabel.click();
          console.log('Clicked second data type label (Float16)');

          // Verify selection by checking which radio button is selected
          const selectedDataType = await this.page.$eval('#dataTypeBtns input:checked', input => ({
            value: input.value,
            id: input.id,
            nextSibling: input.nextElementSibling?.textContent?.trim()
          }));
          console.log('Selected data type:', selectedDataType);

        } else {
          throw new Error('Could not find second label in dataTypeBtns');
        }

      } catch (error) {
        console.error('Data type selection error:', error.message);
        throw error;
      }

      await this.page.waitForTimeout(500);

      // Set model to EfficientNet by clicking the third label in modelBtns
      try {
        // Check what model options are available
        const modelLabels = await this.page.$$eval('#modelBtns label', labels =>
          labels.map((label, index) => ({
            index: index,
            text: label.textContent.trim(),
            value: label.getAttribute('for') || label.querySelector('input')?.value
          }))
        );
        console.log('Available model labels:', modelLabels);

        // Click the fifth label (index 4) in the modelBtns div
        const fifthModelLabel = await this.page.$('#modelBtns label:nth-child(5)');
        if (fifthModelLabel) {
          await fifthModelLabel.click();
          console.log('Clicked fifth model label (EfficientNet)');

          // Verify selection by checking which radio button is selected
          const selectedModel = await this.page.$eval('#modelBtns input:checked', input => ({
            value: input.value,
            id: input.id,
            nextSibling: input.nextElementSibling?.textContent?.trim()
          }));
          console.log('Selected model:', selectedModel);

        } else {
          throw new Error('Could not find fifth label in modelBtns');
        }

      } catch (error) {
        console.error('Model selection error:', error.message);
        throw error;
      }

      await this.page.waitForTimeout(1000);

      // Start checking for prob0 element immediately after model selection
      console.log('Starting to check for prob0 element after model selection...');

      let firstLineProbability = null;
      let checkCount = 0;
      const maxChecks = 30; // 30 checks over 15 seconds
      const checkInterval = 500; // Check every 500ms

      while (checkCount < maxChecks && firstLineProbability === null) {
        checkCount++;
        console.log(`Checking for prob0 element (attempt ${checkCount}/${maxChecks})...`);

        // Check if prob0 element exists and has content
        const probResult = await this.page.evaluate(() => {
          const prob0Element = document.querySelector('#prob0');
          if (prob0Element) {
            const text = prob0Element.textContent || prob0Element.innerText;
            if (text && text.trim()) {
              return { found: true, content: text.trim() };
            }
          }
          return { found: false, content: null };
        });

        if (probResult.found) {
          console.log(`✅ prob0 element found with content: "${probResult.content}"`);

          // Parse the probability from the content
          const content = probResult.content;

          // Look for percentage pattern like "100.00%" or "100%"
          const percentMatch = content.match(/(\d+(?:\.\d+)?)%/);
          if (percentMatch) {
            firstLineProbability = parseFloat(percentMatch[1]);
            console.log(`Parsed percentage: ${firstLineProbability}%`);
            break;
          }

          // Look for decimal probability pattern like "1.0000" or "0.99"
          const probMatch = content.match(/(\d*\.?\d+)/);
          if (probMatch) {
            const prob = parseFloat(probMatch[1]);
            // If it's a probability (0-1), convert to percentage
            if (prob <= 1.0) {
              firstLineProbability = prob * 100;
              console.log(`Parsed decimal probability: ${prob} -> ${firstLineProbability}%`);
            } else {
              firstLineProbability = prob;
              console.log(`Parsed value: ${firstLineProbability}%`);
            }
            break;
          }

          console.log(`⚠️ prob0 element found but could not parse probability from: "${content}"`);
        } else {
          console.log(`❌ prob0 element not found or empty (attempt ${checkCount})`);
        }

        // Wait before next check
        if (checkCount < maxChecks) {
          await this.page.waitForTimeout(checkInterval);
        }
      }

      if (firstLineProbability === null) {
        console.log(`🚫 Failed to find prob0 element with valid content after ${maxChecks} attempts`);
      }

      console.log(`First line probability: ${firstLineProbability}%`);

      // Determine test result
      let testResult = 'UNKNOWN';
      let subcases = { total: 1, passed: 0, failed: 1, details: [] };

      if (firstLineProbability !== null) {
        if (firstLineProbability >= 99.0) { // Allow small tolerance for floating point
          testResult = 'PASS';
          subcases = {
            total: 1,
            passed: 1,
            failed: 0,
            details: [{ name: `First line probability: ${firstLineProbability.toFixed(1)}%`, status: 'PASS' }]
          };
          console.log(`✅ Test PASSED: First line probability is ${firstLineProbability.toFixed(1)}%`);
        } else {
          testResult = 'FAIL';
          subcases = {
            total: 1,
            passed: 0,
            failed: 1,
            details: [{ name: `First line probability: ${firstLineProbability.toFixed(1)}% (expected ~100%)`, status: 'FAIL' }]
          };
          console.log(`❌ Test FAILED: First line probability is ${firstLineProbability.toFixed(1)}% (expected ~100%)`);
        }
      } else {
        testResult = 'FAIL';
        subcases = {
          total: 1,
          passed: 0,
          failed: 1,
          details: [{ name: 'Could not find probability results', status: 'FAIL' }]
        };
        console.log('❌ Test FAILED: Could not find probability results');
      }

      results.push({
        testName,
        testUrl,
        result: testResult,
        errors: [],
        fullText: await this.page.textContent('body'),
        hasErrors: testResult !== 'PASS',
        details: `Probability: ${firstLineProbability || 'N/A'}%`,
        consoleErrors: [],
        pageErrors: [],
        subcases: subcases,
        suite: 'sample'
      });

    } catch (error) {
      console.error(`❌ ERROR running sample test ${testName}:`, error.message);
      results.push({
        testName,
        testUrl,
        result: 'ERROR',
        errors: [{ text: error.message, selector: 'exception' }],
        fullText: `Exception: ${error.message}`,
        hasErrors: true,
        details: error.stack,
        subcases: { total: 1, passed: 0, failed: 1, details: [] },
        suite: 'sample'
      });
    }
  }

  async runPreviewTests() {
    console.log('🚀 Running PREVIEW suite...');
    console.log('Running preview tests...');

    // Get specific test cases from suite-specific environment variable
    const testCaseFilter = process.env.PREVIEW_CASE;
    let testCases = [];

    if (testCaseFilter) {
      testCases = testCaseFilter.split(',').map(c => c.trim()).filter(c => c.length > 0);
      console.log(`Running specific preview test cases: ${testCases.join(', ')}`);
    } else {
      // Default: run all preview test cases
      testCases = ['image-classification'];
      console.log('Running all preview test cases');
    }

    const results = [];

    for (const testCase of testCases) {
      try {
        switch (testCase) {
          case 'image-classification':
            await this.runPreviewImageClassification(results);
            break;
          default:
            console.log(`⚠️ Unknown preview test case: ${testCase}`);
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
      } catch (error) {
        console.error(`❌ Error running preview test case ${testCase}:`, error.message);
        results.push({
          testName: `Preview: ${testCase}`,
          testUrl: '',
          result: 'ERROR',
          errors: [{ text: error.message, selector: 'exception' }],
          fullText: `Exception: ${error.message}`,
          hasErrors: true,
          details: error.stack,
          consoleErrors: [],
          pageErrors: [],
          subcases: { total: 1, passed: 0, failed: 1, details: [] },
          suite: 'preview'
        });
      }
    }

    console.log('✅ Completed preview test execution');
    console.log(`Total preview tests executed: ${results.length}`);

    return results;
  }

  async runPreviewImageClassification(results) {
    const testName = 'WebNN Developer Preview Image Classification';

    try {
      console.log(`Running preview test: ${testName}`);

      // Navigate to the preview demo page
      await this.page.goto('https://microsoft.github.io/webnn-developer-preview/demos/image-classification');
      await this.page.waitForLoadState('networkidle');
      console.log('✓ Navigated to WebNN Developer Preview Image Classification demo');

      // Wait for the page to fully load
      await this.page.waitForTimeout(3000);

      // Look for and click the "Classify" button
      console.log('Looking for Classify button...');

      // Try different possible selectors for the Classify button
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
            console.log(`✓ Found Classify button with selector: ${selector}`);
            break;
          }
        } catch (error) {
          console.log(`Selector "${selector}" not found, trying next...`);
        }
      }

      if (!classifyButton || !(await classifyButton.isVisible())) {
        throw new Error('Could not find Classify button');
      }

      // Click the Classify button
      await classifyButton.click();
      console.log('✓ Clicked Classify button');

      // Start checking for latency element immediately after clicking Classify
      console.log('Starting to check for latency element after clicking Classify...');

      let latencyFound = false;
      let latencyValue = null;
      let checkCount = 0;
      const maxChecks = 30; // 30 checks over 15 seconds
      const checkInterval = 500; // Check every 500ms

      while (checkCount < maxChecks && !latencyFound) {
        checkCount++;
        console.log(`Checking for latency element (attempt ${checkCount}/${maxChecks})...`);

        // Check if latency element exists and has content
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
          console.log(`✅ latency element found with content: "${latencyResult.content}"`);

          // Check if latency value is valid (should be a positive number, not just "0")
          const content = latencyResult.content.trim();

          // Look for numeric patterns (e.g., "12.34ms", "0.123", "45.6 ms", etc.)
          const numericMatch = content.match(/(\d+(?:\.\d+)?)/);
          if (numericMatch) {
            const numericValue = parseFloat(numericMatch[1]);
            if (numericValue > 0) {
              console.log(`✅ Valid latency value found: ${numericValue} (from "${content}")`);
              latencyValue = content;
              latencyFound = true;
              break;
            } else {
              console.log(`❌ latency value is 0 or invalid: ${numericValue} (attempt ${checkCount})`);
            }
          } else {
            console.log(`❌ latency content doesn't contain valid numeric value: "${content}" (attempt ${checkCount})`);
          }
        } else {
          console.log(`❌ latency element not found or empty (attempt ${checkCount})`);
        }

        // Wait before next attempt
        await this.page.waitForTimeout(checkInterval);
      }

      if (!latencyFound) {
        throw new Error(`latency element not found after ${maxChecks} attempts`);
      }

      console.log(`✅ Test PASSED: latency element found with value: ${latencyValue}`);
      results.push({
        testName: testName,
        testUrl: 'https://microsoft.github.io/webnn-developer-preview/demos/image-classification',
        result: 'PASS',
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
      console.error(`❌ Preview test failed: ${error.message}`);
      results.push({
        testName: testName,
        testUrl: 'https://microsoft.github.io/webnn-developer-preview/demos/image-classification',
        result: 'FAIL',
        errors: [{ text: error.message, selector: 'exception' }],
        fullText: `Exception: ${error.message}`,
        hasErrors: true,
        details: error.message,
        consoleErrors: [],
        pageErrors: [],
        subcases: { total: 1, passed: 0, failed: 1, details: [{ name: error.message, status: 'FAIL' }] },
        suite: 'preview'
      });
    }
  }

  generateHtmlReport(testSuites, testCase, results, dllCheckResults = null, wallTime = null, sumOfTestTimes = null) {
    const totalSubcases = results.reduce((sum, r) => sum + r.subcases.total, 0);
    const passedSubcases = results.reduce((sum, r) => sum + r.subcases.passed, 0);
    const failedSubcases = results.reduce((sum, r) => sum + r.subcases.failed, 0);
    const passed = results.filter(r => r.result === 'PASS').length;
    const failed = results.filter(r => r.result === 'FAIL').length;
    const errors = results.filter(r => r.result === 'ERROR').length;

    // Use provided timing data or calculate from individual tests
    const displayWallTime = wallTime || results.reduce((sum, r) => sum + (parseFloat(r.executionTime) || 0), 0).toFixed(2);
    const displaySumOfTimes = sumOfTestTimes || results.reduce((sum, r) => sum + (parseFloat(r.executionTime) || 0), 0).toFixed(2);

    const suiteTitle = testSuites.length > 1 ?
      testSuites.map(s => s.toUpperCase()).join(', ') :
      testSuites[0].toUpperCase();

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>WebNN Test Report - ${suiteTitle}</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 20px; }
        .header { background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
        .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .stat-card { background: white; border: 1px solid #e1e4e8; border-radius: 6px; padding: 15px; text-align: center; }
        .stat-number { font-size: 24px; font-weight: bold; margin-bottom: 5px; }
        .stat-label { color: #586069; font-size: 14px; }
        .pass { color: #28a745; } .fail { color: #dc3545; } .error { color: #fd7e14; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; }
        th { background: #f6f8fa; font-weight: 600; }
        .status-pass { color: #28a745; font-weight: bold; }
        .status-fail { color: #dc3545; font-weight: bold; }
        .status-error { color: #fd7e14; font-weight: bold; }
        .details { margin-top: 20px; }
        .case-details { margin: 15px 0; padding: 15px; border: 1px solid #e1e4e8; border-radius: 6px; }
        .subcase { margin: 5px 0; padding: 5px; background: #f8f9fa; border-radius: 3px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🧪 WebNN Test Report</h1>
        <h2>${testSuites.length > 1 ? 'Suites' : 'Suite'}: ${suiteTitle}${testCase ? ` | Case: "${testCase}"` : ''}</h2>
        <p>Generated: ${new Date().toLocaleString()}</p>
        <p>⏱️ Wall Time (actual duration): <strong>${displayWallTime}s</strong></p>
        <p>⏱️ Sum of Individual Test Times: <strong>${displaySumOfTimes}s</strong></p>
        ${wallTime && sumOfTestTimes && parseFloat(displayWallTime) < parseFloat(displaySumOfTimes) ?
          `<p>⚡ Parallel Speedup: <strong>${(parseFloat(displaySumOfTimes) / parseFloat(displayWallTime)).toFixed(2)}x</strong></p>` : ''}
    </div>

    <h3>📊 Detailed Test Results</h3>
    <table>
        <thead>
            <tr>
                <th>Suite</th>
                <th>Case</th>
                <th>Status</th>
                <th>Passed Subcases</th>
                <th>Failed Subcases</th>
                <th>Total Subcases</th>
                <th>Success Rate</th>
                <th>Retries</th>
                <th>Execution Time</th>
            </tr>
        </thead>
        <tbody>
            ${results.map(result => {
              const retryCount = result.retryHistory ? result.retryHistory.length - 1 : 0;
              const retryInfo = retryCount > 0 ? `${retryCount} retry(ies)` : 'No retries';
              return `
                <tr>
                    <td><strong>${(result.suite || 'N/A').toUpperCase()}</strong></td>
                    <td>
                        <strong>${result.testName}</strong>
                        ${result.testUrl ? `<br><small><a href="${result.testUrl}" target="_blank" style="color: #0366d6;">${result.testUrl}</a></small>` : ''}
                        ${result.retryHistory && result.retryHistory.length > 1 ? `
                        <br><details style="margin-top: 5px;">
                            <summary style="cursor: pointer; color: #0366d6; font-size: 12px;">📊 View Retry History (${retryCount} attempts)</summary>
                            <div style="margin-top: 5px; padding: 10px; background: #f6f8fa; border-radius: 4px;">
                                ${result.retryHistory.map((attempt, idx) => `
                                    <div style="margin: 3px 0; font-size: 11px;">
                                        <strong>${idx === 0 ? 'Initial' : 'Retry ' + idx}:</strong>
                                        <span class="status-${attempt.status.toLowerCase()}">${attempt.status}</span>
                                        (${attempt.passed}/${attempt.total} passed, ${attempt.failed} failed)
                                    </div>
                                `).join('')}
                            </div>
                        </details>
                        ` : ''}
                    </td>
                    <td class="status-${result.result.toLowerCase()}">${result.result}</td>
                    <td class="pass">${result.subcases.passed}</td>
                    <td class="fail">${result.subcases.failed}</td>
                    <td>${result.subcases.total}</td>
                    <td>${result.subcases.total > 0 ? ((result.subcases.passed/result.subcases.total)*100).toFixed(1) : 0}%</td>
                    <td style="font-size: 12px; color: #586069;">${retryInfo}</td>
                    <td>${result.executionTime ? result.executionTime + 's' : 'N/A'}</td>
                </tr>
              `;
            }).join('')}
            <tr style="background: #e8f5e9; font-weight: bold;">
                <td colspan="3"><strong>TOTAL</strong></td>
                <td class="pass"><strong>${passedSubcases}</strong></td>
                <td class="fail"><strong>${failedSubcases}</strong></td>
                <td><strong>${totalSubcases}</strong></td>
                <td><strong>${totalSubcases > 0 ? ((passedSubcases/totalSubcases)*100).toFixed(1) : 0}%</strong></td>
                <td><strong>${results.filter(r => r.retryHistory && r.retryHistory.length > 1).length} tests retried</strong></td>
                <td><strong>${displaySumOfTimes}s</strong></td>
            </tr>
        </tbody>
    </table>

    <div class="summary">
        <div class="stat-card">
            <div class="stat-number">${results.length}</div>
            <div class="stat-label">Total Cases</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${totalSubcases}</div>
            <div class="stat-label">Total Subcases</div>
        </div>
        <div class="stat-card">
            <div class="stat-number pass">${passed}</div>
            <div class="stat-label">Passed Cases</div>
        </div>
        <div class="stat-card">
            <div class="stat-number pass">${passedSubcases}</div>
            <div class="stat-label">Passed Subcases</div>
        </div>
        <div class="stat-card">
            <div class="stat-number fail">${failed}</div>
            <div class="stat-label">Failed Cases</div>
        </div>
        <div class="stat-card">
            <div class="stat-number fail">${failedSubcases}</div>
            <div class="stat-label">Failed Subcases</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${((passedSubcases/totalSubcases)*100).toFixed(1)}%</div>
            <div class="stat-label">Success Rate</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${displayWallTime}s</div>
            <div class="stat-label">Wall Time</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${displaySumOfTimes}s</div>
            <div class="stat-label">Sum of Test Times</div>
        </div>
    </div>

    ${results.filter(r => r.retryHistory && r.retryHistory.length > 1).length > 0 ? `
    <h3>🔄 Retry Analysis</h3>
    <div style="background: #fff3cd; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
        <p><strong>${results.filter(r => r.retryHistory && r.retryHistory.length > 1).length}</strong> test(s) required retries</p>
    </div>
    <table>
        <thead>
            <tr>
                <th>Test Case</th>
                <th>Initial Status</th>
                <th>Final Status</th>
                <th>Retry Attempts</th>
                <th>Subcase Changes</th>
            </tr>
        </thead>
        <tbody>
            ${results.filter(r => r.retryHistory && r.retryHistory.length > 1).map(result => {
              const initial = result.retryHistory[0];
              const final = result.retryHistory[result.retryHistory.length - 1];
              const retryCount = result.retryHistory.length - 1;
              const subcaseChange = final.passed !== initial.passed || final.failed !== initial.failed;
              return `
                <tr>
                    <td><strong>${result.testName}</strong></td>
                    <td class="status-${initial.status.toLowerCase()}">${initial.status}<br><small>(${initial.passed}/${initial.total} passed)</small></td>
                    <td class="status-${final.status.toLowerCase()}">${final.status}<br><small>(${final.passed}/${final.total} passed)</small></td>
                    <td>${retryCount}</td>
                    <td>
                        ${subcaseChange ?
                          `<span style="color: #fd7e14;">⚠️ Changed</span><br>
                           <small>Passed: ${initial.passed} → ${final.passed}<br>
                           Failed: ${initial.failed} → ${final.failed}</small>` :
                          '<span style="color: #28a745;">✓ Consistent</span>'}
                    </td>
                </tr>
                <tr>
                    <td colspan="5" style="padding: 0;">
                        <details style="padding: 10px; background: #f6f8fa;">
                            <summary style="cursor: pointer; font-weight: bold;">View All Attempts</summary>
                            <div style="margin-top: 10px;">
                                ${result.retryHistory.map((attempt, idx) => `
                                    <div style="padding: 8px; margin: 5px 0; background: white; border-left: 3px solid ${attempt.status === 'PASS' ? '#28a745' : attempt.status === 'FAIL' ? '#dc3545' : '#fd7e14'}; border-radius: 3px;">
                                        <strong>${idx === 0 ? 'Initial Run' : 'Retry Attempt ' + idx}:</strong>
                                        <span class="status-${attempt.status.toLowerCase()}">${attempt.status}</span><br>
                                        <small>Passed: ${attempt.passed} | Failed: ${attempt.failed} | Total: ${attempt.total}</small>
                                    </div>
                                `).join('')}
                            </div>
                        </details>
                    </td>
                </tr>
              `;
            }).join('')}
        </tbody>
    </table>
    ` : ''}

    ${dllCheckResults && dllCheckResults.found ? `
    <h3>🔍 ONNX Runtime DLL Detection (--ep flag)</h3>
    <div class="case-details" style="background: #e3f2fd;">
        <h4>✅ ONNX Runtime DLLs Found (${dllCheckResults.dllCount} DLL files)</h4>
        <p><strong>Suite:</strong> ${suiteTitle}</p>
        <p><strong>Detection Time:</strong> ${new Date().toLocaleString()}</p>
        <pre style="background: #f8f9fa; padding: 15px; border-radius: 6px; overflow-x: auto;">${dllCheckResults.dlls}</pre>
    </div>
    ` : dllCheckResults && !dllCheckResults.found ? `
    <h3>🔍 ONNX Runtime DLL Detection (--ep flag)</h3>
    <div class="case-details" style="background: #fff3cd;">
        <h4>❌ No ONNX Runtime DLLs Found</h4>
        <p><strong>Suite:</strong> ${suiteTitle}</p>
        <p><strong>Reason:</strong> ${dllCheckResults.reason || dllCheckResults.error || 'Unknown'}</p>
    </div>
    ` : ''}

</body>
</html>`;
  }

  generateSubcaseTable(testSuites, results) {
    const totalSubcases = results.reduce((sum, r) => sum + r.subcases.total, 0);
    const passedSubcases = results.reduce((sum, r) => sum + r.subcases.passed, 0);
    const failedSubcases = results.reduce((sum, r) => sum + r.subcases.failed, 0);

    const suiteTitle = testSuites.length > 1 ?
      testSuites.map(s => s.toUpperCase()).join(', ') :
      testSuites[0].toUpperCase();

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Subcase Summary - ${suiteTitle}</title>
    <style>
        body { font-family: monospace; background: #f8f9fa; padding: 20px; }
        table { background: white; border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #ccc; padding: 8px 12px; text-align: left; }
        th { background: #e9ecef; font-weight: bold; }
        .summary-row { background: #d4edda; font-weight: bold; }
        .pass { color: #28a745; } .fail { color: #dc3545; } .error { color: #fd7e14; }
    </style>
</head>
<body>
    <h2>📊 Subcases Summary Table - ${suiteTitle}</h2>
    <table>
        <thead>
            <tr>
                <th>Case Name</th>
                <th>Total Subcases</th>
                <th>Passed Subcases</th>
                <th>Failed Subcases</th>
                <th>Status</th>
            </tr>
        </thead>
        <tbody>
            ${results.map(result => `
                <tr>
                    <td>${result.testName}</td>
                    <td>${result.subcases.total}</td>
                    <td class="pass">${result.subcases.passed}</td>
                    <td class="fail">${result.subcases.failed}</td>
                    <td class="${result.result.toLowerCase()}">${result.result === 'PASS' ? '✅ PASS' : result.result === 'FAIL' ? '❌ FAIL' : '🚫 ERROR'}</td>
                </tr>
            `).join('')}
            <tr class="summary-row">
                <td><strong>TOTAL (${suiteTitle})</strong></td>
                <td><strong>${totalSubcases}</strong></td>
                <td class="pass"><strong>${passedSubcases}</strong></td>
                <td class="fail"><strong>${failedSubcases}</strong></td>
                <td><strong>${results.filter(r => r.result === 'PASS').length}/${results.length} cases</strong></td>
            </tr>
        </tbody>
    </table>
</body>
</html>`;
  }

  async sendEmailReport(emailAddress, testSuites, results, wallTime, sumOfTestTimes, reportTimestamp = null) {
    try {
      console.log(`\n📧 Sending email report to ${emailAddress}...`);

      // Calculate summary statistics
      const totalSubcases = results.reduce((sum, r) => sum + r.subcases.total, 0);
      const passedSubcases = results.reduce((sum, r) => sum + r.subcases.passed, 0);
      const successRate = totalSubcases > 0 ? ((passedSubcases / totalSubcases) * 100).toFixed(1) : '0.0';

      const suiteTitle = testSuites.length > 1 ?
        testSuites.map(s => s.toUpperCase()).join(', ') :
        testSuites[0].toUpperCase();

      // Get machine name
      const os = require('os');
      const machineName = os.hostname();

      // Use provided timestamp (from report filename) or generate new one
      const timestamp = reportTimestamp || (() => {
        const now = new Date();
        return now.getFullYear().toString() +
               (now.getMonth() + 1).toString().padStart(2, '0') +
               now.getDate().toString().padStart(2, '0') +
               now.getHours().toString().padStart(2, '0') +
               now.getMinutes().toString().padStart(2, '0') +
               now.getSeconds().toString().padStart(2, '0');
      })();

      // Create email subject with machine name and timestamp (matching report filename format)
      const subject = `WebNN Test Report - ${suiteTitle} - ${successRate}% - ${machineName} - ${timestamp}`;      // Generate the full HTML report using the existing generateHtmlReport method
      const htmlBody = this.generateHtmlReport(testSuites, null, results, null, wallTime, sumOfTestTimes);

      // Use PowerShell to send email via Outlook COM automation
      const { execSync } = require('child_process');
      const fs = require('fs');
      const path = require('path');

      // Create a temporary PowerShell script file to avoid escaping issues
      const tempScriptPath = path.join(os.tmpdir(), `send-email-${Date.now()}.ps1`);

      // Save HTML body to a temporary file
      const tempHtmlPath = path.join(os.tmpdir(), `email-body-${Date.now()}.html`);
      fs.writeFileSync(tempHtmlPath, htmlBody, 'utf8');

      // PowerShell script to send email via Outlook
      const psScript = `
try {
  $outlook = New-Object -ComObject Outlook.Application
  $mail = $outlook.CreateItem(0)
  $mail.To = "${emailAddress}"
  $mail.Subject = @"
${subject}
"@

  # Read HTML content from file
  $htmlContent = Get-Content -Path "${tempHtmlPath.replace(/\\/g, '\\\\')}" -Raw -Encoding UTF8

  # Set HTML body
  $mail.HTMLBody = $htmlContent

  $mail.Send()
  Write-Host "Email sent successfully"
  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($outlook) | Out-Null

  # Clean up temp HTML file
  Remove-Item -Path "${tempHtmlPath.replace(/\\/g, '\\\\')}" -ErrorAction SilentlyContinue

  exit 0
} catch {
  Write-Error $_.Exception.Message
  # Clean up temp HTML file on error
  Remove-Item -Path "${tempHtmlPath.replace(/\\/g, '\\\\')}" -ErrorAction SilentlyContinue
  exit 1
}
`;

      // Write script to temp file
      fs.writeFileSync(tempScriptPath, psScript, 'utf8');

      try {
        // Execute PowerShell script from file
        execSync(`powershell -ExecutionPolicy Bypass -File "${tempScriptPath}"`, {
          encoding: 'utf8',
          stdio: 'inherit'
        });
      } finally {
        // Clean up temp file
        try {
          fs.unlinkSync(tempScriptPath);
        } catch (e) {
          // Ignore cleanup errors
        }
      }

      console.log(`✅ Email sent successfully to ${emailAddress}`);
    } catch (error) {
      console.error(`❌ Failed to send email: ${error.message}`);
      console.error(`   This is a non-critical error - test results are still available in the HTML report`);
    }
  }
}

test.describe('WebNN Automation Tests', () => {
  let testSuites;
  let testCase;

  test.beforeAll(async () => {
    // Get test suite and case from environment variables
    const suiteEnv = process.env.TEST_SUITE || 'wpt';
    testSuites = suiteEnv.split(',').map(s => s.trim()).filter(s => s.length > 0);
    testCase = process.env.TEST_CASE;

    console.log(`Test suites selected: ${testSuites.join(', ')}`);
    if (testCase) {
      const cases = testCase.split(',').map(c => c.trim()).filter(c => c.length > 0);
      console.log(`Specific test cases selected: ${cases.join(', ')}`);
    } else {
      console.log('Running all cases in the selected suite(s)');
    }
  });

  test('WebNN Test Runner', async ({ page, browser, browserName, playwright }) => {
    const runner = new WebNNTestRunner(page);
    let allResults = [];

    // Set timeout to 0 (infinite) to allow for manual debugging pauses
    // This is especially important for the 'abs' test case which pauses indefinitely
    test.setTimeout(0);
    console.log(`⏱️  Test timeout set to infinite (0) for debugging support`);

    // Create a browser launcher function for retry mechanism
    const launchNewBrowser = async () => {
      try {
        // Use playwright fixture to get browser type
        const browserType = playwright.chromium;

        // Get channel from environment (set by main.js), default to 'chrome' (stable)
        const channel = process.env.CHROME_CHANNEL || 'chrome';

        const launchOptions = {
          channel: channel,
          args: [
            '--enable-features=WebMachineLearningNeuralNetwork,WebNNOnnxRuntime',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--enable-unsafe-webgpu'
          ],
          headless: false
        };

        // Allow manual override via executable path if provided
        if (process.env.CHROME_PATH) {
          launchOptions.executablePath = process.env.CHROME_PATH;
          console.log(`🚀 Launching new browser with executable: ${launchOptions.executablePath}`);
        } else {
          console.log(`🚀 Launching new browser with channel: ${channel}`);
        }

        const newBrowser = await browserType.launch(launchOptions);
        console.log(`✅ New browser launched successfully`);
        return newBrowser;
      } catch (error) {
        console.error(`❌ Failed to launch new browser: ${error.message}`);
        console.error(`Stack trace:`, error.stack);
        throw error;
      }
    };

    // Store browser launcher in runner for access during retries
    runner.launchNewBrowser = launchNewBrowser;    // Set test title with suite and case info for better reporting
    const suiteDescription = testSuites.length > 1 ?
      `Suites: "${testSuites.join(', ')}"` :
      `Suite: "${testSuites[0].toUpperCase()}"`;
    const caseDescription = testCase ?
      (testCase.includes(',') ?
        ` | Cases: "${testCase.split(',').map(c => c.trim()).join(', ')}"` :
        ` | Case: "${testCase}"`) : '';
    test.info().annotations.push({
      type: 'suite',
      description: `${suiteDescription}${caseDescription}`
    });

    // Track overall wall time for entire test execution
    const overallStartTime = Date.now();

    // Run tests for each suite with browser restart between suites
    for (let i = 0; i < testSuites.length; i++) {
      const suite = testSuites[i];
      console.log(`\n🚀 Running ${suite.toUpperCase()} suite...`);

      // Restart browser between different suites (but not before the first suite)
      if (i > 0) {
        console.log('🔄 Restarting browser for new suite...');
        const context = page.context();
        await page.close();
        const newPage = await context.newPage();
        // Update the runner's page reference
        runner.page = newPage;
        // Reassign page for subsequent operations
        Object.defineProperty(page, 'goto', { value: newPage.goto.bind(newPage), writable: true });
        Object.defineProperty(page, 'waitForSelector', { value: newPage.waitForSelector.bind(newPage), writable: true });
        Object.defineProperty(page, 'waitForTimeout', { value: newPage.waitForTimeout.bind(newPage), writable: true });
        Object.defineProperty(page, '$$eval', { value: newPage.$$eval.bind(newPage), writable: true });
        Object.defineProperty(page, '$', { value: newPage.$.bind(newPage), writable: true });
        Object.defineProperty(page, 'evaluate', { value: newPage.evaluate.bind(newPage), writable: true });
        Object.defineProperty(page, 'textContent', { value: newPage.textContent.bind(newPage), writable: true });
        Object.defineProperty(page, 'locator', { value: newPage.locator.bind(newPage), writable: true });
        Object.defineProperty(page, 'waitForLoadState', { value: newPage.waitForLoadState.bind(newPage), writable: true });
        Object.defineProperty(page, 'on', { value: newPage.on.bind(newPage), writable: true });
        Object.defineProperty(page, 'context', { value: () => newPage.context(), writable: true });
        Object.defineProperty(page, 'close', { value: newPage.close.bind(newPage), writable: true });
        console.log('✅ Browser restarted successfully');
      }

      let suiteResults = [];

      switch (suite) {
        case 'wpt':
          suiteResults = await runner.runWptTests(page.context(), browser);
          break;
        case 'sample':
          suiteResults = await runner.runSamplesTests();
          break;
        case 'preview':
          suiteResults = await runner.runPreviewTests();
          break;
        default:
          throw new Error(`Unknown test suite: ${suite}`);
      }

      // Add suite information to each result
      suiteResults.forEach(result => {
        result.suite = suite;
      });

      allResults = allResults.concat(suiteResults);
    }

    const results = allResults;

    // Raw test execution info only in console

    // All summary data moved to HTML report - console shows only raw execution info

    // Detailed failure analysis moved to HTML report - console shows only basic execution info

    // Unknown results analysis moved to HTML report

    // Final summary moved to HTML report

    // Calculate summary statistics for display
    const totalSubcasesForReport = results.reduce((sum, r) => sum + r.subcases.total, 0);
    const passedSubcasesForReport = results.reduce((sum, r) => sum + r.subcases.passed, 0);
    const failedSubcasesForReport = results.reduce((sum, r) => sum + r.subcases.failed, 0);
    const passedCasesForReport = results.filter(r => r.result === 'PASS').length;
    const failedCasesForReport = results.filter(r => r.result === 'FAIL').length;
    const errorCasesForReport = results.filter(r => r.result === 'ERROR').length;

    // Calculate overall wall time and sum of test times
    const overallEndTime = Date.now();
    const overallWallTime = ((overallEndTime - overallStartTime) / 1000).toFixed(2);
    const sumOfAllTestTimes = results.reduce((sum, r) => sum + (parseFloat(r.executionTime) || 0), 0).toFixed(2);

    // Attach detailed results to Playwright test info for HTML report
    const testInfo = test.info();

    // Add annotation with summary (visible in report header)
    testInfo.annotations.push({
      type: '📊 Results',
      description: `${passedCasesForReport}/${results.length} cases passed | ${passedSubcasesForReport}/${totalSubcasesForReport} subcases passed (${((passedSubcasesForReport/totalSubcasesForReport)*100).toFixed(1)}%)`
    });

    testInfo.annotations.push({
      type: '⏱️ Timing',
      description: `Wall Time: ${overallWallTime}s | Sum: ${sumOfAllTestTimes}s | Speedup: ${(parseFloat(sumOfAllTestTimes) / parseFloat(overallWallTime)).toFixed(2)}x`
    });

    // Check if we have results
    if (results.length === 0) {
      console.log('⚠️ No tests were executed. Check your filters (suite, case, index, range).');
    }

    // IMMEDIATELY attach reports after assertion, BEFORE any other async operations that create test steps
    // Create detailed HTML report content (note: dllCheckResults will be null initially)
    const htmlReport = runner.generateHtmlReport(testSuites, testCase, results, null, overallWallTime, sumOfAllTestTimes);

    // Save timestamped HTML report to report/ folder
    const fs = require('fs');
    const path = require('path');
    const reportDir = path.join(process.cwd(), 'report');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }
    // Format timestamp as YYYYMMDDHHMMSS
    const now = new Date();
    const timestamp = now.getFullYear().toString() +
                     (now.getMonth() + 1).toString().padStart(2, '0') +
                     now.getDate().toString().padStart(2, '0') +
                     now.getHours().toString().padStart(2, '0') +
                     now.getMinutes().toString().padStart(2, '0') +
                     now.getSeconds().toString().padStart(2, '0');
    const reportFileName = `${timestamp}.html`;
    const reportPath = path.join(reportDir, reportFileName);
    fs.writeFileSync(reportPath, htmlReport, 'utf8');
    console.log(`\n📄 HTML Report saved to: ${reportPath}`);

    // Store the timestamp for email subject (same as report filename)
    const reportTimestamp = timestamp;

    // Attach the detailed HTML report AFTER assertions (appears after Test Steps)
    await testInfo.attach('📄 WebNN-Test-Report', {
      body: htmlReport,
      contentType: 'text/html'
    });

    // Attach raw logs for debugging (appears after main report)
    await testInfo.attach('📊 Raw-Test-Data', {
      body: JSON.stringify({
        suites: testSuites,
        case: testCase,
        summary: {
          totalCases: results.length,
          totalSubcases: totalSubcasesForReport,
          passedCases: passedCasesForReport,
          failedCases: failedCasesForReport,
          errorCases: errorCasesForReport,
          passedSubcases: passedSubcasesForReport,
          failedSubcases: failedSubcasesForReport,
          successRate: ((passedSubcasesForReport/totalSubcasesForReport)*100).toFixed(1),
          wallTime: overallWallTime,
          sumOfTestTimes: sumOfAllTestTimes
        },
        results: results,
        dllCheck: null
      }, null, 2),
      contentType: 'application/json'
    });

    // Handle --ep flag: keep browser alive and check ONNX Runtime DLLs once at the end
    // This happens AFTER attachments to avoid creating test steps between assertion and attachments
    let dllCheckResults = null;
    if (runner.epFlag) {
      console.log('\n🔍 EP flag detected - checking ONNX Runtime DLLs after all tests...');
      console.log('⏳ Keeping browser open for DLL check...');

      // Run DLL check once at the very end
      const dllCheck = await runner.checkOnnxRuntimeDlls();
      dllCheckResults = dllCheck;

      if (dllCheck.found) {
        console.log(`✅ ONNX Runtime DLLs detected in Chrome process (${dllCheck.dllCount} DLL files found)`);
      } else {
        console.log('❌ No ONNX Runtime DLLs found in Chrome process');
      }

      // Close the browser after DLL check completes
      console.log('🔒 DLL check completed - closing browser...');
    }

    // Log summary for the test result
    console.log(`\n🎯 PLAYWRIGHT REPORT SUMMARY:`);
    const finalSuiteSummary = testSuites.length > 1 ?
      `Suites: ${testSuites.join(', ')}` :
      `Suite: ${testSuites[0]}`;
    console.log(`${finalSuiteSummary}, Cases: ${results.length}, Subcases: ${passedSubcasesForReport}/${totalSubcasesForReport} passed`);

    // Send email report if --email option was provided
    const emailAddress = process.env.EMAIL_ADDRESS;
    if (emailAddress) {
      await runner.sendEmailReport(emailAddress, testSuites, results, overallWallTime, sumOfAllTestTimes, reportTimestamp);
    }    // You can add more specific assertions based on your requirements
    // For example, expect a minimum pass rate:
    // expect(passedSubcasesForReport / totalSubcasesForReport).toBeGreaterThan(0.8);
  });
});