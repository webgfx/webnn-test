
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

class WebNNRunner {
  constructor(page) {
    this.page = page;
    this.epFlag = process.env.EP_FLAG === 'true';
    this.launchNewBrowser = null;
  }

  // Ensure the page is available, recreating it if necessary
  async ensurePage() {
    if (this.page.isClosed()) {
      try {
        console.log('[Info] Page was closed, creating new page...');
        this.page = await this.page.context().newPage();
      } catch (e) {
        console.log('[Warning] Could not create new page from context, restarting browser...');
        const instance = await this.restartBrowserAndContext();
        this.page = instance.page;
      }
    }
  }

  // Wrapper for running a test with session failure monitoring
  async runTestWithSessionCheck(testFn, shouldRestart = true) {
    await this.ensurePage();
    const pageInUse = this.page;

    let sessionInitFailed = false;
    let sessionFailureMessage = '';

    const checkFailure = async (text) => {
      if (text.toLowerCase().includes('failed to create session')) {
        if (!sessionInitFailed) {
          sessionInitFailed = true;
          sessionFailureMessage = text;
          const msg = shouldRestart ? 'Restarting browser...' : 'Browser restart skipped (last case).';
          console.error(`[Fail] [Auto-Fail] "Failed to create session" detected. ${msg}`);
          try { await pageInUse.close(); } catch (e) {}
        }
      }
    };

    const failConsoleListener = async (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === 'error') {
        console.log(`[Browser Console] ${type}: ${text}`);
      }
      await checkFailure(text);
    };

    const failErrorListener = (err) => {
      const text = err.message || String(err);
      console.log(`[Browser Page Error] ${text}`);
      checkFailure(text);
    };

    pageInUse.on('console', failConsoleListener);
    pageInUse.on('pageerror', failErrorListener);

    try {
      await testFn();
      // Check if session failed even if testFn swallowed the error (e.g. via internal try/catch)
      if (sessionInitFailed) {
        throw new Error(`Failed to create session: ${sessionFailureMessage}`);
      }
    } catch (error) {
      if (sessionInitFailed) {
        console.log('[Info] Handling session failure recovery...');
        if (shouldRestart) {
          try {
              const currentContext = pageInUse.context();
              const objectToClose = currentContext.browser() || currentContext;
              const instance = await this.restartBrowserAndContext(objectToClose);
              this.page = instance.page;
          } catch (restartError) {
              console.error(`[Error] Failed to restart browser: ${restartError.message}`);
          }
        }
        throw new Error(`Failed to create session: ${sessionFailureMessage}`);
      }
      throw error;
    } finally {
      try {
        if (!pageInUse.isClosed()) {
            pageInUse.removeListener('console', failConsoleListener);
            pageInUse.removeListener('pageerror', failErrorListener);
        }
      } catch (e) {}
    }
  }

  // Helper function to check if two results are identical (works for both PASS and FAIL)
  compareTestResults(result1, result2) {
    if (!result1 || !result2) return false;
    if (result1.result !== result2.result) return false;

    // Compare subcase counts
    const sc1 = result1.subcases;
    const sc2 = result2.subcases;
    if (sc1.total !== sc2.total || sc1.passed !== sc2.passed || sc1.failed !== sc2.failed) {
      return false;
    }

    return true;
  }

  async restartBrowserAndContext(browserToClose) {
    if (browserToClose) {
      try {
        console.log('[Info] Closing browser before restart...');
        await browserToClose.close();
        console.log('[Success] Browser closed');
      } catch (e) {
        console.log(`[Warning] Error closing browser: ${e.message}`);
      }
    }

    // Force kill browser process to ensure clean restart (resolves "Failed to launch persistent context" issues)
    try {
        const channel = process.env.CHROME_CHANNEL || 'chrome';
        const processName = channel.includes('edge') ? 'msedge.exe' : 'chrome.exe';
        console.log(`[Info] Ensuring process ${processName} is terminated (taskkill)...`);
        execSync(`taskkill /F /IM ${processName}`, { stdio: 'ignore' });
    } catch (e) {
        // Process might not exist, which is fine
    }

    // Wait a bit to ensure process is fully gone
    await new Promise(resolve => setTimeout(resolve, 3000));

    if (!this.launchNewBrowser) {
      throw new Error('launchNewBrowser function is not defined');
    }

    console.log('[Info] Launching new browser...');
    const result = await this.launchNewBrowser();

    let newBrowser, newContext, newPage;

    // Handle both { browser } return type (Launch) and { context, page } return type (PersistentContext)
    if (result.context) {
        // Persistent Context case
        newBrowser = null; // No browser object exposed
        newContext = result.context;
        newPage = result.page;
        console.log('[Success] New persistent context launched');
    } else {
        // Standard Launch case
        newBrowser = result;
        console.log('[Success] New browser launched');
        console.log('[Info] Creating new context...');
        newContext = await newBrowser.newContext();
        console.log(`[Success] Created fresh browser context (ID: ${newContext._guid || 'N/A'})`);
        newPage = null; // Will be created by caller or here?
    }

    return { browser: newBrowser, context: newContext, page: newPage };
  }

  async checkOnnxruntimeDlls(processName = 'chrome.exe') {
    return new Promise((resolve) => {
      console.log(`[Info] Checking for ONNX Runtime DLLs in ${processName} process...`);

      // Construct path to Listdlls64.exe in tools folder
      // We use __dirname to be relative to src/util.js, going up to root then tools
      const toolsPath = path.join(__dirname, '..', 'tools', 'Listdlls64.exe');

      // Run Listdlls64.exe -v <processName> and filter for onnxruntime*.dll files
      // Note: Using findstr on Windows with pattern matching for .dll files
      // Use quotes around executable path to handle spaces
      const command = `"${toolsPath}" -v ${processName} | findstr /i "onnxruntime.*\\.dll"`;

      console.log(`Running command: ${command}`);
      const { exec } = require('child_process');
      exec(command, { encoding: 'utf8', timeout: 60000 }, (error, stdout, stderr) => {
        if (error) {
           console.log(`[Warning] Error/No output checking ONNX Runtime DLLs: ${error.message}`);
           resolve({ found: false, error: error.message });
           return;
        }

        const output = stdout;
        if (output && output.trim()) {
           // Verify that we actually found .dll files, not just any text containing "onnxruntime"
           // Filter out "Command line:" lines which Listdlls might print if they match the grep
           const dllLines = output.trim().split('\n')
               .filter(line => line.includes('.dll') && !line.trim().startsWith('Command line:'));

           if (dllLines.length > 0) {
               console.log(`[Success] ONNX Runtime DLL files found in ${processName} process:`);
               const cleanOutput = dllLines.join('\n');
               console.log(cleanOutput);
               resolve({ found: true, dlls: cleanOutput, dllCount: dllLines.length });
           } else {
               console.log(`[Fail] No ONNX Runtime DLL files found in ${processName} process (verified content)`);
               resolve({ found: false, dlls: '', reason: 'No .dll files in output' });
           }
        } else {
            console.log(`[Fail] No ONNX Runtime DLL files found in ${processName} process`);
            resolve({ found: false, dlls: '', reason: 'No output from command' });
        }
      });
    });
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
        .summary { margin-bottom: 20px; }
        .stat-card { background: white; border: 1px solid #e1e4e8; border-radius: 6px; padding: 15px; text-align: center; display: inline-block; margin: 5px; min-width: 150px; }
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
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 20px; background-color: #ffffff;">
    <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #e1e4e8;">
        <h1 style="margin: 0; color: #24292e;">WebNN Test Report</h1>
    </div>

    <div style="margin-bottom: 20px;">
        <h3>Summary</h3>
        <table style="width: 100%; border-collapse: separate; border-spacing: 12px; margin-bottom: 20px;">
            <tr>
                <td style="text-align: center; padding: 20px; background: #ffffff; border: 1px solid #e1e4e8; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); width: 33%;">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: #24292e;">${results.length}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Total Cases</div>
                </td>
                <td style="text-align: center; padding: 20px; background: #ffffff; border: 1px solid #e1e4e8; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); width: 33%;">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: #24292e;">${totalSubcases}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Total Subcases</div>
                </td>
                <td style="text-align: center; padding: 20px; background: #ffffff; border: 1px solid #e1e4e8; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); width: 33%;">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: ${((passedSubcases/totalSubcases)*100) >= 100 ? '#28a745' : '#24292e'};">${Math.floor(((passedSubcases/totalSubcases)*100)*10)/10}%</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Success Rate</div>
                </td>
            </tr>
            <tr>
                <td style="text-align: center; padding: 20px; background: #f0fff4; border: 1px solid #c3e6cb; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: #28a745;">${passed}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Passed Cases</div>
                </td>
                <td style="text-align: center; padding: 20px; background: #f0fff4; border: 1px solid #c3e6cb; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: #28a745;">${passedSubcases}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Passed Subcases</div>
                </td>
                <td style="text-align: center; padding: 20px; background: #ffffff; border: 1px solid #e1e4e8; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: #586069;">${displayWallTime}s</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Wall Time</div>
                </td>
            </tr>
            <tr>
                <td style="text-align: center; padding: 20px; background: ${failed > 0 ? '#fff5f5' : '#ffffff'}; border: 1px solid ${failed > 0 ? '#f5c6cb' : '#e1e4e8'}; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: ${failed > 0 ? '#dc3545' : '#586069'};">${failed}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Failed Cases</div>
                </td>
                <td style="text-align: center; padding: 20px; background: ${failedSubcases > 0 ? '#fff5f5' : '#ffffff'}; border: 1px solid ${failedSubcases > 0 ? '#f5c6cb' : '#e1e4e8'}; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: ${failedSubcases > 0 ? '#dc3545' : '#586069'};">${failedSubcases}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Failed Subcases</div>
                </td>
                <td style="text-align: center; padding: 20px; background: #ffffff; border: 1px solid #e1e4e8; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: #586069;">${displaySumOfTimes}s</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Sum of Test Times</div>
                </td>
            </tr>
        </table>
    </div>

    <h3>Detailed Test Results</h3>
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-family: sans-serif;">
        <thead>
            <tr>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background: #f6f8fa; font-weight: 600;">Suite</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background: #f6f8fa; font-weight: 600;">Case</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background: #f6f8fa; font-weight: 600;">Status</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background: #f6f8fa; font-weight: 600;">Passed Subcases</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background: #f6f8fa; font-weight: 600;">Failed Subcases</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background: #f6f8fa; font-weight: 600;">Total Subcases</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background: #f6f8fa; font-weight: 600;">Success Rate</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background: #f6f8fa; font-weight: 600;">Retries</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background: #f6f8fa; font-weight: 600;">Execution Time</th>
            </tr>
        </thead>
        <tbody>
            ${results.map(result => {
              const retryCount = result.retryHistory ? result.retryHistory.length - 1 : 0;
              const retryInfo = retryCount > 0 ? `${retryCount} retry(ies)` : 'No retries';
              const statusColor = result.result === 'PASS' ? '#28a745' : result.result === 'FAIL' ? '#dc3545' : '#fd7e14';
              const statusStyle = `color: ${statusColor}; font-weight: bold;`;
              const baseTdStyle = "border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left;";

              return `
                <tr>
                    <td style="${baseTdStyle}"><strong>${(result.suite || 'N/A').toUpperCase()}</strong></td>
                    <td style="${baseTdStyle}">
                        <strong>${result.testName}</strong>
                        ${result.testUrl ? `<br><small><a href="${result.testUrl}" target="_blank" style="color: #0366d6;">${result.testUrl}</a></small>` : ''}
                        ${result.details && !result.details.includes('Exception') ? `<br><div style="margin-top:4px; font-size: 0.9em; color: #24292e; background: #e6ffed; padding: 5px; border-left: 3px solid #28a745; border-radius: 2px;">${result.details}</div>` : ''}
                        ${result.fullText && result.hasErrors ? `<br><div style="margin-top:4px; font-size: 0.9em; color: #a00; background: #fff0f0; padding: 5px; border-left: 3px solid #a00; border-radius: 2px;">${result.fullText}</div>` : ''}
                        ${result.retryHistory && result.retryHistory.length > 1 ? `
                        <br><details style="margin-top: 5px;">
                            <summary style="cursor: pointer; color: #0366d6; font-size: 12px;">View Retry History (${retryCount} attempts)</summary>
                            <div style="margin-top: 5px; padding: 10px; background: #f6f8fa; border-radius: 4px;">
                                ${result.retryHistory.map((attempt, idx) => `
                                    <div style="margin: 3px 0; font-size: 11px;">
                                        <strong>${idx === 0 ? 'Initial' : 'Retry ' + idx}:</strong>
                                        <span style="color: ${attempt.status === 'PASS' ? '#28a745' : attempt.status === 'FAIL' ? '#dc3545' : '#fd7e14'}; font-weight: bold;">${attempt.status}</span>
                                        (${attempt.passed}/${attempt.total} passed, ${attempt.failed} failed)
                                    </div>
                                `).join('')}
                            </div>
                        </details>
                        ` : ''}
                    </td>
                    <td style="${baseTdStyle} ${statusStyle}">${result.result}</td>
                    <td style="${baseTdStyle} color: #28a745;">${result.subcases.passed}</td>
                    <td style="${baseTdStyle} color: #dc3545;">${result.subcases.failed}</td>
                    <td style="${baseTdStyle}">${result.subcases.total}</td>
                    <td style="${baseTdStyle}">${result.subcases.total > 0 ? ((result.subcases.passed/result.subcases.total)*100).toFixed(1) : 0}%</td>
                    <td style="${baseTdStyle} font-size: 12px; color: #586069;">${retryInfo}</td>
                    <td style="${baseTdStyle}">${result.executionTime ? result.executionTime + 's' : 'N/A'}</td>
                </tr>
              `;
            }).join('')}
            <tr style="background: #e8f5e9; font-weight: bold;">
                <td colspan="3" style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left;"><strong>TOTAL</strong></td>
                <td style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; color: #28a745;"><strong>${passedSubcases}</strong></td>
                <td style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; color: #dc3545;"><strong>${failedSubcases}</strong></td>
                <td style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left;"><strong>${totalSubcases}</strong></td>
                <td style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left;"><strong>${totalSubcases > 0 ? ((passedSubcases/totalSubcases)*100).toFixed(1) : 0}%</strong></td>
                <td style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left;"><strong>${results.filter(r => r.retryHistory && r.retryHistory.length > 1).length} tests retried</strong></td>
                <td style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left;"><strong>${displaySumOfTimes}s</strong></td>
            </tr>
        </tbody>
    </table>

    ${results.filter(r => r.retryHistory && r.retryHistory.length > 1).length > 0 ? `
    <h3>Retry Analysis</h3>
    <div style="background: #fff3cd; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
        <p><strong>${results.filter(r => r.retryHistory && r.retryHistory.length > 1).length}</strong> test(s) required retries</p>
    </div>
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-family: sans-serif;">
        <thead>
            <tr>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background: #f6f8fa; font-weight: 600;">Test Case</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background: #f6f8fa; font-weight: 600;">Initial Status</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background: #f6f8fa; font-weight: 600;">Final Status</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background: #f6f8fa; font-weight: 600;">Retry Attempts</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background: #f6f8fa; font-weight: 600;">Subcase Changes</th>
            </tr>
        </thead>
        <tbody>
            ${results.filter(r => r.retryHistory && r.retryHistory.length > 1).map(result => {
              const initial = result.retryHistory[0];
              const final = result.retryHistory[result.retryHistory.length - 1];
              const retryCount = result.retryHistory.length - 1;
              const subcaseChange = final.passed !== initial.passed || final.failed !== initial.failed;

              const baseTdStyle = "border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left;";
              const getStatusColor = (status) => status === 'PASS' ? '#28a745' : status === 'FAIL' ? '#dc3545' : '#fd7e14';

              return `
                <tr>
                    <td style="${baseTdStyle}"><strong>${result.testName}</strong></td>
                    <td style="${baseTdStyle} font-weight: bold; color: ${getStatusColor(initial.status)};">${initial.status}<br><small style="font-weight: normal; color: #586069;">(${initial.passed}/${initial.total} passed)</small></td>
                    <td style="${baseTdStyle} font-weight: bold; color: ${getStatusColor(final.status)};">${final.status}<br><small style="font-weight: normal; color: #586069;">(${final.passed}/${final.total} passed)</small></td>
                    <td style="${baseTdStyle}">${retryCount}</td>
                    <td style="${baseTdStyle}">
                        ${subcaseChange ?
                          `<span style="color: #fd7e14;">[Changed]</span><br>
                           <small>Passed: ${initial.passed} -> ${final.passed}<br>
                           Failed: ${initial.failed} -> ${final.failed}</small>` :
                          '<span style="color: #28a745;">[Consistent]</span>'}
                    </td>
                </tr>
                <tr>
                    <td colspan="5" style="padding: 0; border: 1px solid #e1e4e8;">
                        <details style="padding: 10px; background: #f6f8fa;">
                            <summary style="cursor: pointer; font-weight: bold;">View All Attempts</summary>
                            <div style="margin-top: 10px;">
                                ${result.retryHistory.map((attempt, idx) => `
                                    <div style="padding: 8px; margin: 5px 0; background: white; border-left: 3px solid ${getStatusColor(attempt.status)}; border-radius: 3px;">
                                        <strong>${idx === 0 ? 'Initial Run' : 'Retry Attempt ' + idx}:</strong>
                                        <span style="font-weight: bold; color: ${getStatusColor(attempt.status)};">${attempt.status}</span><br>
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
    <h3>ONNX Runtime DLL Detection</h3>
    <div style="margin: 15px 0; padding: 15px; border: 1px solid #e1e4e8; border-radius: 6px; background: #e3f2fd;">
        <h4 style="margin-top: 0;">ONNX Runtime DLLs Found (${dllCheckResults.dllCount} DLL files)</h4>
        <p><strong>Detection Time:</strong> ${new Date().toLocaleString()}</p>
        <pre style="background: #f8f9fa; padding: 15px; border-radius: 6px; overflow-x: auto; font-family: monospace;">${dllCheckResults.dlls}</pre>
    </div>
    ` : dllCheckResults && !dllCheckResults.found ? `
    <h3>ONNX Runtime DLL Detection</h3>
    <div style="margin: 15px 0; padding: 15px; border: 1px solid #e1e4e8; border-radius: 6px; background: #fff3cd;">
        <h4 style="margin-top: 0;">No ONNX Runtime DLLs Found</h4>
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
    <h2>Subcases Summary Table - ${suiteTitle}</h2>
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
                    <td class="${result.result.toLowerCase()}">${result.result === 'PASS' ? 'PASS' : result.result === 'FAIL' ? 'FAIL' : 'ERROR'}</td>
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

  async sendEmailReport(emailAddress, testSuites, results, wallTime, sumOfTestTimes, reportTimestamp = null, htmlReportContent = null) {
    try {
      console.log(`\n[Info] Sending email report to ${emailAddress}...`);

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

      // Get GPU info
      let gpuName = 'Unknown GPU';
      try {
        const base = require('../../util/base');
        const gpuInfo = base.get_gpu_info();
        if (gpuInfo.name) {
            gpuName = gpuInfo.name;
        }
      } catch (e) {
        console.log('[Warning] Could not retrieve GPU info:', e.message);
      }

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

      // Create email subject: [WebNN Test Report] timestamp | machine name | gpu type
      const subject = `[WebNN Test Report] ${timestamp} | ${machineName} | ${gpuName}`;

      // Use provided HTML content or generate new one
      const htmlBody = htmlReportContent || this.generateHtmlReport(testSuites, null, results, null, wallTime, sumOfTestTimes);

      // Use send_email from util/base.js
      const base = require('../../util/base');
      await base.send_email(subject, htmlBody, '', emailAddress);

      console.log(`[Success] Email sent successfully to ${emailAddress}`);
    } catch (error) {
      console.error(`[Fail] Failed to send email: ${error.message}`);
      console.error(`   This is a non-critical error - test results are still available in the HTML report`);
    }
  }
}

module.exports = { WebNNRunner };
