import { test, expect } from '@playwright/test';

class WebNNTestRunner {
  constructor(page) {
    this.page = page;
    this.epFlag = process.env.EP_FLAG === 'true';
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

  async runWptTests() {
    console.log('Running WPT tests...');
    
    // Get specific test cases from suite-specific environment variable
    const testCaseFilter = process.env.WPT_CASE;
    let testCases = [];
    if (testCaseFilter) {
      testCases = testCaseFilter.split(',').map(c => c.trim()).filter(c => c.length > 0);
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
    
    // Apply test case selection if specified - run cases sequentially
    if (testCases.length > 0) {
      const orderedTestFiles = [];
      testCases.forEach(testCase => {
        const caseFiles = testFiles.filter(testFile => 
          testFile.toLowerCase().includes(testCase.toLowerCase())
        );
        console.log(`Found ${caseFiles.length} test files for case "${testCase}":`, caseFiles);
        orderedTestFiles.push(...caseFiles);
      });
      
      // Remove duplicates while preserving order (in case a file matches multiple cases)
      testFiles = [...new Set(orderedTestFiles)];
      console.log(`Selected ${testFiles.length} test files in sequential order for cases "${testCases.join(', ')}":`, testFiles);
    } else {
      console.log(`Found ${testFiles.length} test files:`, testFiles);
    }

    const results = [];
    
    for (const testFile of testFiles) {
      // Convert .js to .html and add ?gpu parameter
      const testName = testFile.replace('.js', '.html');
      const testUrl = `https://wpt.live/webnn/conformance_tests/${testName}?gpu`;
      
      console.log(`Running test: ${testName}`);
      
      try {
        // Capture console errors
        const consoleErrors = [];
        this.page.on('console', msg => {
          if (msg.type() === 'error') {
            consoleErrors.push(`Console Error: ${msg.text()}`);
          }
        });
        
        // Capture page errors
        const pageErrors = [];
        this.page.on('pageerror', error => {
          pageErrors.push(`Page Error: ${error.message}`);
        });
        
        // Navigate to the test
        await this.page.goto(testUrl, { waitUntil: 'networkidle' });
        
        // Wait for test results (WPT tests typically show results in the page)
        await this.page.waitForTimeout(5000); // Give time for tests to run
        
        // Extract total test count from "Found xx tests" text after rerun button
        const totalTestsInfo = await this.page.evaluate(() => {
          const rerunButton = document.getElementById('rerun');
          if (rerunButton) {
            // Look for <p> element after the rerun button
            let nextElement = rerunButton.nextElementSibling;
            while (nextElement) {
              if (nextElement.tagName === 'P') {
                const text = nextElement.textContent.trim();
                const match = text.match(/Found (\d+) tests?/i);
                if (match) {
                  return {
                    totalTests: parseInt(match[1]),
                    text: text
                  };
                }
              }
              nextElement = nextElement.nextElementSibling;
            }
          }
          return { totalTests: null, text: null };
        });
        
        // Check if the test passed or failed and analyze subcases
        // WPT tests typically show results in a specific format
        const testResult = await this.page.evaluate(() => {
          const body = document.body.textContent;
          const bodyHTML = document.body.innerHTML;
          
          // Parse WPT subcases - look for common patterns
          const subcases = {
            total: 0,
            passed: 0,
            failed: 0,
            details: []
          };
          
          // First, try to parse the "Found <xxx> tests<yy> Pass<zz> Fail" pattern
          // Example: "Found 45 tests30 Pass15 Fail" or "Found 45 tests 30 Pass 15 Fail"
          // Also handles when all pass: "Found 45 tests45 Pass" (no Fail part)
          const foundPatternWithFail = body.match(/Found\s+(\d+)\s+tests?\s*(\d+)\s+Pass\s*(\d+)\s+Fail/i);
          const foundPatternAllPass = body.match(/Found\s+(\d+)\s+tests?\s*(\d+)\s+Pass(?!\s*\d+\s+Fail)/i);
          
          if (foundPatternWithFail) {
            subcases.total = parseInt(foundPatternWithFail[1]);
            subcases.passed = parseInt(foundPatternWithFail[2]);
            subcases.failed = parseInt(foundPatternWithFail[3]);
          } else if (foundPatternAllPass) {
            // All tests passed - no Fail count in the text
            subcases.total = parseInt(foundPatternAllPass[1]);
            subcases.passed = parseInt(foundPatternAllPass[2]);
            subcases.failed = 0;
          } else {
            // Look for WPT subtest patterns - count PASS and FAIL elements
            const subtestElements = document.querySelectorAll('.status, .subtest, [class*="test"]');
            subtestElements.forEach(el => {
              const text = el.textContent.trim();
              const className = el.className;
              
              if (className.includes('pass') || text.includes('PASS')) {
                subcases.passed++;
                subcases.details.push({ name: text, status: 'PASS' });
              } else if (className.includes('fail') || text.includes('FAIL')) {
                subcases.failed++;
                subcases.details.push({ name: text, status: 'FAIL' });
              }
            });
            
            // If no explicit subtests found, look for test result patterns in text
            if (subcases.passed === 0 && subcases.failed === 0) {
              const passMatches = body.match(/(\d+)\s*\/\s*(\d+)\s*tests?\s*passed/i);
              const failMatches = body.match(/(\d+)\s*tests?\s*failed/i);
              const totalMatches = body.match(/(\d+)\s*tests?\s*run/i);
              
              if (passMatches) {
                subcases.passed = parseInt(passMatches[1]);
                subcases.total = parseInt(passMatches[2]);
                subcases.failed = subcases.total - subcases.passed;
              } else if (failMatches) {
                subcases.failed = parseInt(failMatches[1]);
              } else if (totalMatches) {
                subcases.total = parseInt(totalMatches[1]);
              }
            }
          }
          
          return { 
            body: body,
            bodyHTML: bodyHTML,
            subcases: subcases
          };
        });
        
        // Use the parsed values if we got them from "Found X tests Y Pass Z Fail" pattern
        if (testResult.subcases.total > 0 && testResult.subcases.passed >= 0 && testResult.subcases.failed >= 0) {
          console.log(`📊 Parsed from page: ${testResult.subcases.total} tests total, ${testResult.subcases.passed} passed, ${testResult.subcases.failed} failed`);
        } else if (totalTestsInfo.totalTests !== null) {
          // Fallback: Override total count with the accurate count from "Found xx tests" if available
          const originalTotal = testResult.subcases.total;
          testResult.subcases.total = totalTestsInfo.totalTests;
          
          // Calculate passed count: total - failed
          if (testResult.subcases.failed > 0) {
            testResult.subcases.passed = testResult.subcases.total - testResult.subcases.failed;
            console.log(`📊 Found ${totalTestsInfo.totalTests} tests: ${testResult.subcases.passed} passed, ${testResult.subcases.failed} failed`);
          } else if (testResult.subcases.passed > 0) {
            // If we have passed count but no failed count, recalculate failed
            testResult.subcases.failed = testResult.subcases.total - testResult.subcases.passed;
            console.log(`📊 Found ${totalTestsInfo.totalTests} tests: ${testResult.subcases.passed} passed, ${testResult.subcases.failed} failed`);
          } else {
            // We have total but no passed/failed breakdown yet
            console.log(`📊 Found ${totalTestsInfo.totalTests} tests (breakdown to be determined)`);
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
        const errorDetails = await this.page.evaluate(() => {
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
        
        results.push({
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
          totalTestsFromPage: totalTestsInfo.totalTests,
          suite: 'wpt'
        });

        // Enhanced console output with breakdown
        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`Test ${testName}: ${overallStatus}`);
        if (totalTestsInfo.totalTests !== null) {
          console.log(`  📋 Total tests (from page): ${totalTestsInfo.totalTests}`);
        }
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

      } catch (error) {
        console.error(`❌ ERROR running test ${testName}:`, error.message);
        console.error('Stack trace:', error.stack);
        results.push({
          testName,
          testUrl,
          result: 'ERROR',
          errors: [{ text: error.message, selector: 'exception' }],
          fullText: `Exception: ${error.message}`,
          hasErrors: true,
          details: error.stack,
          subcases: { total: 1, passed: 0, failed: 1, details: [] },
          suite: 'wpt'
        });
      }
    }

    // Log execution summary
    if (testCases.length > 0) {
      console.log(`\n✅ Completed sequential execution of cases: ${testCases.join(' → ')}`);
      console.log(`Total test files executed: ${results.length}`);
    }
    
    return results;
  }

  async runSamplesTests() {
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

  generateHtmlReport(testSuites, testCase, results, dllCheckResults = null) {
    const totalSubcases = results.reduce((sum, r) => sum + r.subcases.total, 0);
    const passedSubcases = results.reduce((sum, r) => sum + r.subcases.passed, 0);
    const failedSubcases = results.reduce((sum, r) => sum + r.subcases.failed, 0);
    const passed = results.filter(r => r.result === 'PASS').length;
    const failed = results.filter(r => r.result === 'FAIL').length;
    const errors = results.filter(r => r.result === 'ERROR').length;

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
            </tr>
        </thead>
        <tbody>
            ${results.map(result => `
                <tr>
                    <td><strong>${(result.suite || 'N/A').toUpperCase()}</strong></td>
                    <td>
                        <strong>${result.testName}</strong>
                        ${result.testUrl ? `<br><small><a href="${result.testUrl}" target="_blank" style="color: #0366d6;">${result.testUrl}</a></small>` : ''}
                    </td>
                    <td class="status-${result.result.toLowerCase()}">${result.result}</td>
                    <td class="pass">${result.subcases.passed}</td>
                    <td class="fail">${result.subcases.failed}</td>
                    <td>${result.subcases.total}</td>
                    <td>${result.subcases.total > 0 ? ((result.subcases.passed/result.subcases.total)*100).toFixed(1) : 0}%</td>
                </tr>
            `).join('')}
            <tr style="background: #e8f5e9; font-weight: bold;">
                <td colspan="3"><strong>TOTAL</strong></td>
                <td class="pass"><strong>${passedSubcases}</strong></td>
                <td class="fail"><strong>${failedSubcases}</strong></td>
                <td><strong>${totalSubcases}</strong></td>
                <td><strong>${totalSubcases > 0 ? ((passedSubcases/totalSubcases)*100).toFixed(1) : 0}%</strong></td>
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
    </div>

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

  test('WebNN Test Runner', async ({ page, browser }) => {
    const runner = new WebNNTestRunner(page);
    let allResults = [];

    // Set timeout to 10 minutes for all test suites
    const testTimeout = 600000; // 10 minutes
    test.setTimeout(testTimeout);
    console.log(`⏱️  Test timeout set to ${testTimeout / 60000} minutes`);

    // Set test title with suite and case info for better reporting
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
          suiteResults = await runner.runWptTests();
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

    // Handle --ep flag: keep browser alive and check ONNX Runtime DLLs once at the end
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

    // Attach detailed results to Playwright test info for HTML report
    const testInfo = test.info();
    
    // Create detailed HTML report content with DLL results
    const htmlReport = runner.generateHtmlReport(testSuites, testCase, results, dllCheckResults);
    
    // Attach the detailed HTML report as body content (displayed inline at top)
    await testInfo.attach('WebNN-Test-Report', {
      body: htmlReport,
      contentType: 'text/html'
    });
    
    // Attach raw logs at the end for debugging
    await testInfo.attach('Raw-Test-Data', {
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
          successRate: ((passedSubcasesForReport/totalSubcasesForReport)*100).toFixed(1)
        },
        results: results,
        dllCheck: dllCheckResults
      }, null, 2),
      contentType: 'application/json'
    });

    // Assert that we have some results
    expect(results.length).toBeGreaterThan(0);
    
    // Log summary for the test result
    console.log(`\n🎯 PLAYWRIGHT REPORT SUMMARY:`);
    const finalSuiteSummary = testSuites.length > 1 ? 
      `Suites: ${testSuites.join(', ')}` : 
      `Suite: ${testSuites[0]}`;
    console.log(`${finalSuiteSummary}, Cases: ${results.length}, Subcases: ${passedSubcasesForReport}/${totalSubcasesForReport} passed`);    // You can add more specific assertions based on your requirements
    // For example, expect a minimum pass rate:
    // expect(passedSubcasesForReport / totalSubcasesForReport).toBeGreaterThan(0.8);
  });
});