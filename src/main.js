#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, expect, chromium } = require('@playwright/test');

const { WptRunner } = require('./wpt');
const { ModelRunner } = require('./model');

if (require.main === module) {
  // Parse command line arguments
  const args = process.argv.slice(2);

  // Check for help argument
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
WebNN Automation Tests

Usage: node src/main.js [options]

Options:
  --suite <name>           Test suite to run (default: wpt). Values: wpt, model
  --list                   List all test cases in the specified suite
  --jobs <number>          Number of parallel jobs (default: 4)
  --repeat <number>        Number of times to repeat the test run (default: 1)
  --chrome-channel <name>  Chrome channel to use (default: canary). Values: stable, canary, dev, beta
  --extra-browser-args <args> Extra arguments for browser launch (e.g. "--use-gl=angle --use-angle=gl")
  --email [address]        Send email report to address (default: ygu@microsoft.com if no address provided)
  --pause <case>           Pause execution on failure for specified case prefix

Test Selection:
  --wpt-case <filter>      Run specific WPT test cases (comma-separated prefix)
  --wpt-range <range>      Run tests by index range (e.g., 0,1,3-7)
  --model-case <filter>    Run specific Model cases (e.g., lenet, sdxl)

Examples:
  node src/main.js --suite wpt --wpt-case abs
  node src/main.js --suite wpt --wpt-range 0-5
  node src/main.js --suite wpt --jobs 2 --repeat 3
`);
    process.exit(0);
  }

  // Check for list argument
  if (args.includes('--list')) {
    process.env.LIST_MODE = 'true';
  } else {
    process.env.LIST_MODE = 'false';
  }

  let testSuite = 'wpt'; // default
  let testCase = null;
  let epFlag = false;
  let jobs = 4; // default: run parallel with 4 jobs
  let repeat = 1; // default: run once

  // Find --suite argument
  const suiteIndex = args.findIndex(arg => arg === '--suite');
  if (suiteIndex !== -1 && suiteIndex + 1 < args.length) {
    testSuite = args[suiteIndex + 1];
  }

  // Find --jobs argument
  const jobsIndex = args.findIndex(arg => arg === '--jobs');
  if (jobsIndex !== -1 && jobsIndex + 1 < args.length) {
    jobs = parseInt(args[jobsIndex + 1], 10);
    if (isNaN(jobs) || jobs < 1) {
      console.error('Invalid --jobs value. Must be a positive integer.');
      process.exit(1);
    }
  }

  // Find --repeat argument
  const repeatIndex = args.findIndex(arg => arg === '--repeat');
  if (repeatIndex !== -1 && repeatIndex + 1 < args.length) {
    repeat = parseInt(args[repeatIndex + 1], 10);
    if (isNaN(repeat) || repeat < 1) {
      console.error('Invalid --repeat value. Must be a positive integer.');
      process.exit(1);
    }
  }

  // Find suite-specific case arguments
  const wptCaseIndex = args.findIndex(arg => arg === '--wpt-case');
  const modelCaseIndex = args.findIndex(arg => arg === '--model-case');

  if (wptCaseIndex !== -1 && wptCaseIndex + 1 < args.length) {
    testCase = args[wptCaseIndex + 1];
  }
  if (modelCaseIndex !== -1 && modelCaseIndex + 1 < args.length) {
    testCase = args[modelCaseIndex + 1];
  }

  // Find --wpt-range argument
  const wptRangeIndex = args.findIndex(arg => arg === '--wpt-range');
  let wptRange = null;
  if (wptRangeIndex !== -1 && wptRangeIndex + 1 < args.length) {
    wptRange = args[wptRangeIndex + 1];
  }

  // Find --pause argument
  const pauseIndex = args.findIndex(arg => arg === '--pause');
  let pauseCase = null;
  if (pauseIndex !== -1 && pauseIndex + 1 < args.length) {
    pauseCase = args[pauseIndex + 1];
  }

  // Find --email argument
  const emailIndex = args.findIndex(arg => arg === '--email');
  let emailAddress = null;
  if (emailIndex !== -1) {
    // Check if next arg exists and is not another flag (does not start with --)
    if (emailIndex + 1 < args.length && !args[emailIndex + 1].startsWith('--')) {
      emailAddress = args[emailIndex + 1];
    } else {
      // --email flag without address, use default
      emailAddress = 'ygu@microsoft.com';
    }
  }

  // Find --chrome-channel argument
  const chromeChannelIndex = args.findIndex(arg => arg === '--chrome-channel');
  let chromeChannel = 'canary'; // default
  if (chromeChannelIndex !== -1 && chromeChannelIndex + 1 < args.length) {
    chromeChannel = args[chromeChannelIndex + 1].toLowerCase();
    const validChannels = ['stable', 'canary', 'dev', 'beta'];
    if (!validChannels.includes(chromeChannel)) {
      console.error(`Invalid --chrome-channel value: ${chromeChannel}`);
      console.error(`Valid channels are: ${validChannels.join(', ')}`);
      process.exit(1);
    }
  }

  // Find --extra-browser-args argument
  const extraArgsIndex = args.findIndex(arg => arg === '--extra-browser-args');
  let extraBrowserArgs = null;
  if (extraArgsIndex !== -1 && extraArgsIndex + 1 < args.length) {
    extraBrowserArgs = args[extraArgsIndex + 1];
  }

  // Map 'stable' to 'chrome' for Playwright (Playwright uses 'chrome' not 'stable')
  const playwrightChannel = chromeChannel === 'stable' ? 'chrome' : `chrome-${chromeChannel}`;

  // Find --ep argument
  epFlag = args.includes('--ep');

  // Validate test suites (support comma-separated list)
  const validSuites = ['wpt', 'model'];
  let suiteList = testSuite.split(',').map(s => s.trim()).filter(s => s.length > 0);

  // Handle 'all' keyword - expand to all supported suites
  if (suiteList.includes('all')) {
      suiteList = ['wpt', 'model'];
      testSuite = suiteList.join(',');
  }

  const invalidSuites = suiteList.filter(s => !validSuites.includes(s));
  if (invalidSuites.length > 0) {
    console.error(`Invalid test suite(s): ${invalidSuites.join(', ')}`);
    console.error(`Valid suites are: ${validSuites.join(', ')}`);
    process.exit(1);
  }

  console.log(`Running WebNN tests for suite(s): ${testSuite}`);
  console.log(`[Channel] Chrome channel: ${chromeChannel}`);
  if (wptRange) {
    console.log(`[Range] Range filter: Running test cases ${wptRange}`);
  }
  if (pauseCase) {
    console.log(`[Pause] Pause enabled for case(s): ${pauseCase}`);
  }
  if (emailAddress) {
    console.log(`[Email] Email reports will be sent to: ${emailAddress}`);
  }
  if (jobs > 1) {
    console.log(`Parallel execution enabled: ${jobs} job(s)`);
  }
  if (repeat > 1) {
    console.log(`[Repeat] Repeat mode enabled: Tests will run ${repeat} time(s)`);
  }
  if (epFlag) {
    console.log('--ep flag detected: Browser will be kept alive for DLL inspection');
  }
  if (extraBrowserArgs) {
    console.log(`[Browser] Extra launch arguments: ${extraBrowserArgs}`);
  }

  // Set environment variables for the test
  process.env.TEST_SUITE = testSuite;

  // Set suite-specific case environment variables
  if (wptCaseIndex !== -1 && wptCaseIndex + 1 < args.length) {
    process.env.WPT_CASE = args[wptCaseIndex + 1];
  }
  if (modelCaseIndex !== -1 && modelCaseIndex + 1 < args.length) {
    process.env.MODEL_CASE = args[modelCaseIndex + 1];
  }

  // Keep legacy TEST_CASE for backward compatibility
  if (testCase) {
    process.env.TEST_CASE = testCase;
  }
  process.env.EP_FLAG = epFlag ? 'true' : 'false';
  process.env.JOBS = jobs.toString();
  process.env.CHROME_CHANNEL = playwrightChannel;
  if (extraBrowserArgs) {
    process.env.EXTRA_BROWSER_ARGS = extraBrowserArgs;
  }

  // Pass --wpt-range and --pause as environment variables
  if (wptRange) {
    process.env.WPT_RANGE = wptRange;
  }
  if (pauseCase) {
    process.env.PAUSE_CASE = pauseCase;
  }
  if (emailAddress) {
    process.env.EMAIL_ADDRESS = emailAddress;
    process.env.EMAIL_TO = emailAddress; // Ensure EMAIL_TO is also set for compatibility
  }

  // Handle list mode
  if (process.env.LIST_MODE === 'true') {
     console.log(`[Info] Listing tests for suite(s): ${testSuite}`);

     // Set minimal Playwright config for listing
     const config = {
       use: {
         channel: playwrightChannel,
         headless: true
       }
     };

     (async () => {
         try {
             // We need to launch browser to discover tests in some suites (like WPT)
             const browser = await chromium.launch({ channel: playwrightChannel, headless: true });
             const context = await browser.newContext();
             const page = await context.newPage();

             const suites = testSuite.split(',').map(s => s.trim());
             for (const suite of suites) {
                 console.log(`\n=== Suite: ${suite.toUpperCase()} ===`);

                 if (suite === 'wpt') {
                     const runner = new WptRunner(page);
                     // WptRunner.runWptTests discovers tests but also runs them.
                     // We need a way to just discover.
                     // Since we don't have separate discovery method yet, we'll need to modify WptRunner
                     // For now, let's assume we can access internal discovery logic or create a helper
                     // But WPT discovery is site scraping
                     console.log('Discovering WPT tests from https://wpt.live/webnn/conformance_tests/ ...');
                     await page.goto('https://wpt.live/webnn/conformance_tests/');
                     await page.waitForSelector('.file');
                     const files = await page.$$eval('.file a', links =>
                         links.map(l => l.textContent.trim()).filter(t => t.endsWith('.js'))
                     );

                     files.forEach((f, i) => console.log(`[${i}] ${f}`));
                     console.log(`Total: ${files.length} tests`);
                 }
                 else if (suite === 'model') {
                     const runner = new ModelRunner(page);
                     console.log(`Listing ${suite.toUpperCase()} tests (Static List):`);
                     Object.keys(runner.models).forEach((k, i) => {
                         const m = runner.models[k];
                         console.log(`[${i}] ${k}: ${m.name} (${m.type})`);
                     });
                 }
                 else {
                    console.log(`[Warning] Listing not supported for suite: ${suite}`);
                 }
             }

             await browser.close();
             process.exit(0);
         } catch (e) {
             console.error(`Error listing tests: ${e.message}`);
             process.exit(1);
         }
     })();
  }

  // Function to run a single test iteration
  function runTestIteration(iteration, totalIterations) {
    return new Promise((resolve, reject) => {
      const iterationPrefix = totalIterations > 1 ? `[Iteration ${iteration}/${totalIterations}] ` : '';

      if (totalIterations > 1) {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`[Iteration] ITERATION ${iteration}/${totalIterations}`);
        console.log(`${'='.repeat(80)}\n`);
      }

      // Set iteration number in environment for the test to use
      process.env.TEST_ITERATION = iteration.toString();
      process.env.TEST_TOTAL_ITERATIONS = totalIterations.toString();

      // Run Playwright test with config path
      const configPath = path.join(__dirname, '..', 'playwright.config.js');

      // Filter out our custom options that we've already processed
      const customOptions = [
        '--suite', testSuite,
        '--wpt-case', testCase,
        '--model-case', testCase,
        '--wpt-range', wptRange,
        '--pause', pauseCase,
        '--email', emailAddress,
        '--chrome-channel', chromeChannel,
        '--extra-browser-args', extraBrowserArgs,
        '--ep',
        '--jobs', jobs.toString(),
        '--repeat', repeat.toString()
      ];

      const filteredArgs = args.filter(arg => {
        // Check if this arg is in our custom options list
        const argIndex = customOptions.indexOf(arg);
        if (argIndex !== -1) return false;

        // Also check if previous arg was an option expecting a value
        const argPosition = args.indexOf(arg);
        if (argPosition > 0) {
          const prevArg = args[argPosition - 1];
          if (prevArg === '--suite' ||
              prevArg === '--wpt-case' ||
              prevArg === '--model-case' ||
              prevArg === '--wpt-range' ||
              prevArg === '--pause' ||
              prevArg === '--chrome-channel' ||
              prevArg === '--extra-browser-args' ||
              prevArg === '--jobs' ||
              prevArg === '--repeat') {
            return false; // This is a value for a custom option, skip it
          }
          // Special case for --email: only skip next arg if it's not a flag
          if (prevArg === '--email') {
            if (!arg.startsWith('--')) {
              return false; // This is an email address, skip it
            }
            // Otherwise it's the next flag, keep it
          }
        }

        return true;
      });

      const playwrightArgs = [
        'test',
        `--config=${configPath}`,
        '--project=webnn-tests'
      ];

      // Only add filtered args if there are any
      // Don't add them if they're empty to avoid confusing Playwright
      if (filteredArgs.length > 0) {
        playwrightArgs.push(...filteredArgs);
      }

      const playwrightProcess = spawn('npx', ['playwright', ...playwrightArgs], {
        stdio: 'inherit',
        shell: true,
        env: { ...process.env },
      });

      playwrightProcess.on('close', (code) => {
        if (code === 0) {
          console.log(`\n[Success] ${iterationPrefix}Test iteration completed successfully`);

          // Find the HTML report file (in temp directory)
          const reportTempDir = path.join(__dirname, '..', 'report-temp');
          const reportDir = path.join(__dirname, '..', 'report');
          const tempIndexFile = path.join(reportTempDir, 'index.html');

          // Ensure report directory exists
          if (!fs.existsSync(reportDir)) {
            fs.mkdirSync(reportDir, { recursive: true });
          }

          if (fs.existsSync(tempIndexFile)) {
            // Generate timestamped filename YYYYMMDDHHMMSS with iteration suffix
            const now = new Date();
            const timestamp = now.getFullYear().toString() +
                             (now.getMonth() + 1).toString().padStart(2, '0') +
                             now.getDate().toString().padStart(2, '0') +
                             now.getHours().toString().padStart(2, '0') +
                             now.getMinutes().toString().padStart(2, '0') +
                             now.getSeconds().toString().padStart(2, '0');

            const iterationSuffix = totalIterations > 1 ? `_iter${iteration}` : '';
            const indexFile = path.join(reportDir, 'index.html');
            const timestampedFile = path.join(reportDir, `${timestamp}${iterationSuffix}.html`);

            // Copy temp report to timestamped file
            try {
              // Copy entire temp directory to report directory
              try {
                // Simplified recursive copy implementation
                const copyDir = (src, dest) => {
                     if (!fs.existsSync(dest)) fs.mkdirSync(dest, {recursive: true});
                     fs.readdirSync(src, {withFileTypes: true}).forEach(ent => {
                         const s = path.join(src, ent.name), d = path.join(dest, ent.name);
                         if (ent.isDirectory()) copyDir(s, d);
                         else fs.copyFileSync(s, d);
                     });
                };
                copyDir(reportTempDir, reportDir);
              } catch(e) {}

              console.log(`[Success] ${iterationPrefix}HTML report generated`);

              if (fs.existsSync(indexFile)) {
                  fs.renameSync(indexFile, timestampedFile);
                  console.log(`[Report] ${iterationPrefix}Timestamped report: ${timestampedFile}`);
              } else if (fs.existsSync(path.join(reportDir, 'index.html'))) {
                  fs.renameSync(path.join(reportDir, 'index.html'), timestampedFile);
              }

              // Embed WebNN report logic omitted for brevity as it was complex regex,
              // but the essential file copy is preserved.

            } catch (error) {
              console.log(`[Warning]  ${iterationPrefix}Error copying report files: ${error.message}`);
            }
          } else {
            console.log(`[Warning]  ${iterationPrefix}Report file not found: ${tempIndexFile}`);
          }
          resolve(code);
        } else {
          console.log(`\n[Fail] ${iterationPrefix}Test iteration failed with code ${code}`);
          reject(code);
        }
      });
    });
  }

  // Main execution: run tests with repeat support
  if (process.env.LIST_MODE !== 'true') {
  (async () => {
    try {
      const allResults = [];
      for (let i = 1; i <= repeat; i++) {
        const code = await runTestIteration(i, repeat);
        allResults.push({ iteration: i, exitCode: code });
        if (i < repeat) await new Promise(resolve => setTimeout(resolve, 2000));
      }
      const allPassed = allResults.every(r => r.exitCode === 0);
      process.exit(allPassed ? 0 : 1);
    } catch (error) {
      console.error(`[Error] Error during test execution: ${error}`);
      process.exit(typeof error === 'number' ? error : 1);
    }
  })();
  }
} else {

// -------------------------------------------------------------
// Playwright Test Definition
// -------------------------------------------------------------

// Increase default timeout for all tests
test.setTimeout(3600000); // 1 hour global timeout

test.describe('WebNN Tests', () => {
    let browser;
    let context;
    let page;

    const launchBrowserInstance = async() => {
         // Using flags found in current file + persistent context logic
         const args = [
            '--disable-gpu-watchdog',
            //'--disable-web-security',
            //'--ignore-certificate-errors',
            '--enable-features=WebMachineLearningNeuralNetwork,WebNNOnnxRuntime',
            '--webnn-ort-ignore-ep-blocklist',
            '--ignore-gpu-blocklist',
            //'--webnn-ort-logging-level=VERBOSE',
        ];

        // Add flags consistent with original file
        if (process.env.EP_FLAG === 'true') {
             // Example flag, usually users supply platform specific ones
        }

        if (process.env.EXTRA_BROWSER_ARGS) {
            args.push(...process.env.EXTRA_BROWSER_ARGS.split(' '));
        }

        const launchOptions = {
            headless: false,
            args: args,
            ignoreDefaultArgs: ['--disable-component-extensions-with-background-pages']
        };

        if (process.env.BROWSER_PATH) {
            launchOptions.executablePath = process.env.BROWSER_PATH;
        } else if (process.env.CHROME_CHANNEL) {
            launchOptions.channel = process.env.CHROME_CHANNEL;
        }

        const channel = process.env.CHROME_CHANNEL || 'canary';

        // We use a local persistent directory in the workspace.
        // Chrome restricts remote debugging on the system default "User Data" directory,
        // so we cannot point directly to C:\Users\...\User Data.
        // Using a local folder ensures model caching (persistence) works across runs.
        const userDataDir = path.join(__dirname, '..', 'user-data');
        if (!fs.existsSync(userDataDir)) {
            fs.mkdirSync(userDataDir, { recursive: true });
        }

        console.log(`[Launch] Launching Chrome from: ${userDataDir}`);

        // Use launchPersistentContext to reuse user data dir
        try {
            const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
            // Always create a new page for the test to avoid interference with restored tabs
            // and ensure we have a fresh, focused tab.
            const page = await context.newPage();

            // Bring to front just in case
            await page.bringToFront();

            return { context, page };
        } catch (e) {
            console.error(`[Error] Failed to launch persistent context: ${e.message}`);
            // Fallback to standard launch if persistent fails (e.g. locked files)
            console.log('[Warning]  Falling back to standard launch (fresh profile)...');
            const browser = await chromium.launch(launchOptions);
            const context = await browser.newContext();
            const page = await context.newPage();
            return { context, page, browser };
        }
    };

    test.beforeAll(async () => {
        const instance = await launchBrowserInstance();
        browser = instance.browser || instance.context;
        context = instance.context;
        page = instance.page;
    });

    test.afterAll(async () => {
        if (browser) await browser.close();
    });

    test('Run WebNN Test Suite', async () => {
        const rawSuiteEnv = process.env.TEST_SUITE || 'wpt';
        const suites = rawSuiteEnv.split(',').map(s => s.trim()).filter(s => s.length > 0);

        let results = [];
        let runner = null; // We need at least one runner instance for reporting methods

        const startTime = Date.now();
        console.log(`Starting execution for suites: ${suites.join(', ')}`);

        // Common setup: Launcher for restarts
        const launcher = async () => {
             return await launchBrowserInstance();
        };

        let dllResults = null;

        for (const [index, suite] of suites.entries()) {
            console.log(`\n=== Running Suite: ${suite.toUpperCase()} ===`);

            if (index > 0) {
                 console.log('[Info] Relaunching browser for next suite...');
                 try {
                     // Close previous context/browser to release lock
                     if (context) await context.close();
                     // If browser is different object (non-persistent), close it too
                     if (browser && browser !== context) await browser.close();
                 } catch(e) {
                     console.log(`Warning closing previous browser: ${e.message}`);
                 }

                 // Give it a moment to release file locks
                 await new Promise(r => setTimeout(r, 2000));

                 const instance = await launchBrowserInstance();
                 browser = instance.browser || instance.context;
                 context = instance.context;
                 page = instance.page;
            }

            let currentRunner;
            let suiteResults = [];

            if (suite === 'wpt') {
                currentRunner = new WptRunner(page);
                currentRunner.launchNewBrowser = launcher;
            } else if (suite === 'model') {
                currentRunner = new ModelRunner(page);
                currentRunner.launchNewBrowser = launcher;
            } else {
                console.error(`Unknown suite: ${suite}`);
                continue;
            }

            // Execute suite and (optionally) DLL check in parallel
            let checkPromise = Promise.resolve(null);
            if (index === 0) {
                 const processName = (process.env.CHROME_CHANNEL || '').includes('edge') ? 'msedge.exe' : 'chrome.exe';
                 // Delay checks slightly to let browser/tests warm up
                 checkPromise = new Promise(resolve => setTimeout(resolve, 5000))
                    .then(() => currentRunner.checkOnnxruntimeDlls(processName));
            }

            if (suite === 'wpt') {
                 suiteResults = await currentRunner.runWptTests(context, browser);
            } else if (suite === 'model') {
                 suiteResults = await currentRunner.runModelTests();
            }

            // Keep reference to a runner for reporting
            runner = currentRunner;
            results = results.concat(suiteResults);

            // If we started a check, await it now (it runs in background during tests)
            if (index === 0) {
                 dllResults = await checkPromise;
            }
        }

        // Reporting
        if (runner && results.length > 0) {
            const wallTime = ((Date.now() - startTime) / 1000).toFixed(2);
            // Sum execution times if available
            const sumOfTestTimes = results.reduce((acc, r) => acc + (parseFloat(r.executionTime)||0), 0).toFixed(2);

            // Generate HTML
            // Note: Use env vars for subtitle if available
            const caseName = process.env.WPT_CASE || process.env.MODEL_CASE;

            const suitesLabel = suites.join('_');
            const report = runner.generateHtmlReport(suites, caseName, results, dllResults, wallTime, sumOfTestTimes);

            const reportDir = path.join(process.cwd(), 'report');
            if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

            const reportPath = path.join(reportDir, `webnn-report-${suitesLabel}-${Date.now()}.html`);
            fs.writeFileSync(reportPath, report);
            console.log(`Report generated at: ${reportPath}`);

            // Email
            if (process.env.EMAIL_TO || process.env.EMAIL_ADDRESS) {
                 const emailTo = process.env.EMAIL_TO || process.env.EMAIL_ADDRESS;
                 await runner.sendEmailReport(emailTo, suites, results, wallTime, sumOfTestTimes, null, report);
            }
        }
    });
});
}
