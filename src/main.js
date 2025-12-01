#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
let testSuite = 'wpt'; // default
let testCase = null;
let epFlag = false;
let jobs = 1; // default: run sequentially
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
const sampleCaseIndex = args.findIndex(arg => arg === '--sample-case');
const previewCaseIndex = args.findIndex(arg => arg === '--preview-case');

if (wptCaseIndex !== -1 && wptCaseIndex + 1 < args.length) {
  testCase = args[wptCaseIndex + 1];
}
if (sampleCaseIndex !== -1 && sampleCaseIndex + 1 < args.length) {
  testCase = args[sampleCaseIndex + 1];
}
if (previewCaseIndex !== -1 && previewCaseIndex + 1 < args.length) {
  testCase = args[previewCaseIndex + 1];
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
  // Check if next arg exists and is not another flag (doesn't start with --)
  if (emailIndex + 1 < args.length && !args[emailIndex + 1].startsWith('--')) {
    emailAddress = args[emailIndex + 1];
  } else {
    // --email flag without address, use default
    emailAddress = 'ygu@microsoft.com';
  }
}

// Find --chrome-channel argument
const chromeChannelIndex = args.findIndex(arg => arg === '--chrome-channel');
let chromeChannel = 'stable'; // default
if (chromeChannelIndex !== -1 && chromeChannelIndex + 1 < args.length) {
  chromeChannel = args[chromeChannelIndex + 1].toLowerCase();
  const validChannels = ['stable', 'canary', 'dev', 'beta'];
  if (!validChannels.includes(chromeChannel)) {
    console.error(`Invalid --chrome-channel value: ${chromeChannel}`);
    console.error(`Valid channels are: ${validChannels.join(', ')}`);
    process.exit(1);
  }
}

// Map 'stable' to 'chrome' for Playwright (Playwright uses 'chrome' not 'stable')
const playwrightChannel = chromeChannel === 'stable' ? 'chrome' : `chrome-${chromeChannel}`;

// Find --ep argument
epFlag = args.includes('--ep');

// Validate test suites (support comma-separated list)
const validSuites = ['wpt', 'sample', 'preview'];
const suiteList = testSuite.split(',').map(s => s.trim()).filter(s => s.length > 0);
const invalidSuites = suiteList.filter(s => !validSuites.includes(s));
if (invalidSuites.length > 0) {
  console.error(`Invalid test suite(s): ${invalidSuites.join(', ')}`);
  console.error(`Valid suites are: ${validSuites.join(', ')}`);
  process.exit(1);
}

console.log(`Running WebNN tests for suite(s): ${testSuite}`);
console.log(`🌐 Chrome channel: ${chromeChannel}`);
if (testCase) {
  console.log(`Running specific case: ${testCase}`);
}
if (wptRange) {
  console.log(`📊 Range filter: Running test cases ${wptRange}`);
}
if (pauseCase) {
  console.log(`🛑 Pause enabled for case(s): ${pauseCase}`);
}
if (emailAddress) {
  console.log(`📧 Email reports will be sent to: ${emailAddress}`);
}
if (jobs > 1) {
  console.log(`Parallel execution enabled: ${jobs} job(s)`);
}
if (repeat > 1) {
  console.log(`🔁 Repeat mode enabled: Tests will run ${repeat} time(s)`);
}
if (epFlag) {
  console.log('--ep flag detected: Browser will be kept alive for DLL inspection');
}

// Set environment variables for the test
process.env.TEST_SUITE = testSuite;

// Set suite-specific case environment variables
if (wptCaseIndex !== -1 && wptCaseIndex + 1 < args.length) {
  process.env.WPT_CASE = args[wptCaseIndex + 1];
}
if (sampleCaseIndex !== -1 && sampleCaseIndex + 1 < args.length) {
  process.env.SAMPLE_CASE = args[sampleCaseIndex + 1];
}
if (previewCaseIndex !== -1 && previewCaseIndex + 1 < args.length) {
  process.env.PREVIEW_CASE = args[previewCaseIndex + 1];
}

// Keep legacy TEST_CASE for backward compatibility
if (testCase) {
  process.env.TEST_CASE = testCase;
}
process.env.EP_FLAG = epFlag ? 'true' : 'false';
process.env.JOBS = jobs.toString();
process.env.CHROME_CHANNEL = playwrightChannel;

// Pass --wpt-range and --pause as environment variables
if (wptRange) {
  process.env.WPT_RANGE = wptRange;
}
if (pauseCase) {
  process.env.PAUSE_CASE = pauseCase;
}
if (emailAddress) {
  process.env.EMAIL_ADDRESS = emailAddress;
}

// Function to run a single test iteration
function runTestIteration(iteration, totalIterations) {
  return new Promise((resolve, reject) => {
    const iterationPrefix = totalIterations > 1 ? `[Iteration ${iteration}/${totalIterations}] ` : '';

    if (totalIterations > 1) {
      console.log(`\n${'='.repeat(80)}`);
      console.log(`🔁 ITERATION ${iteration}/${totalIterations}`);
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
      '--sample-case', testCase,
      '--preview-case', testCase,
      '--wpt-range', wptRange,
      '--pause', pauseCase,
      '--email', emailAddress,
      '--chrome-channel', chromeChannel,
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
            prevArg === '--sample-case' ||
            prevArg === '--preview-case' ||
            prevArg === '--wpt-range' ||
            prevArg === '--pause' ||
            prevArg === '--chrome-channel' ||
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

    // Note: We don't pass --wpt-range and --pause to Playwright
    // The test code reads them directly from process.argv
    // We need to preserve the original args in the spawned process

    const playwrightProcess = spawn('npx', ['playwright', ...playwrightArgs], {
      stdio: 'inherit',
      shell: true,
      env: { ...process.env },
      // Pass original process.argv so test code can read --wpt-range and --pause
      // This is inherited automatically through the shell
    });

    playwrightProcess.on('close', (code) => {
      if (code === 0) {
        console.log(`\n✅ ${iterationPrefix}Test iteration completed successfully`);

        const fs = require('fs');
        const path = require('path');

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
            // First, copy the entire report-temp directory structure to report
            const copyDirRecursive = (src, dest) => {
              if (!fs.existsSync(dest)) {
                fs.mkdirSync(dest, { recursive: true });
              }
              const entries = fs.readdirSync(src, { withFileTypes: true });
              for (const entry of entries) {
                const srcPath = path.join(src, entry.name);
                const destPath = path.join(dest, entry.name);
                if (entry.isDirectory()) {
                  copyDirRecursive(srcPath, destPath);
                } else {
                  fs.copyFileSync(srcPath, destPath);
                }
              }
            };

            // Copy entire temp directory to report directory
            copyDirRecursive(reportTempDir, reportDir);

            console.log(`✅ ${iterationPrefix}HTML report generated`);

            // Rename index.html to timestamped file
            fs.renameSync(indexFile, timestampedFile);
            console.log(`📄 ${iterationPrefix}Timestamped report: ${timestampedFile}`);

            // Modify the generated report to embed WebNN Test Report at the top
            try {
              const htmlContent = fs.readFileSync(timestampedFile, 'utf-8');

              // Try to extract the test result page link
              const testPageMatch = htmlContent.match(/href="(data\/[a-f0-9]+\.html)"/);

              if (testPageMatch) {
                const testPagePath = path.join(reportDir, testPageMatch[1]);

                // Read and modify the test detail page
                if (fs.existsSync(testPagePath)) {
                  let detailHtml = fs.readFileSync(testPagePath, 'utf-8');

                  // Remove testId from URL by adding a script to clean the URL
                  const urlCleanScript = `
<script>
// Remove testId from URL on page load
if (window.location.search || window.location.hash.includes('testId')) {
  const url = new URL(window.location.href);
  url.search = '';
  const hash = url.hash.split('?')[0]; // Remove query params from hash
  url.hash = hash;
  window.history.replaceState({}, document.title, url.toString());
}
</script>`;

                  // Find the WebNN-Test-Report attachment and extract it
                  const attachmentMatch = detailHtml.match(/<div[^>]*class="[^"]*attachment[^"]*"[^>]*data-attachment-name="WebNN-Test-Report"[^>]*>([\s\S]*?)<\/div>/);

                  if (attachmentMatch) {
                    // Extract the iframe content
                    const iframeMatch = attachmentMatch[0].match(/<iframe[^>]*srcdoc="([^"]*)"[^>]*>/);

                    if (iframeMatch) {
                      // Decode the srcdoc content
                      const reportContent = iframeMatch[1]
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&quot;/g, '"')
                        .replace(/&amp;/g, '&');

                      // Add iteration info if repeating
                      const iterationHeader = totalIterations > 1
                        ? `<div style="background: #3498db; color: white; padding: 10px; border-radius: 4px; margin-bottom: 15px; font-weight: bold;">🔁 Iteration ${iteration} of ${totalIterations}</div>`
                        : '';

                      // Create a wrapper for the WebNN report at the top
                      const webnnReportSection = `
<div style="margin: 20px 0; padding: 20px; background: #f8f9fa; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px;">📊 WebNN Test Report</h2>
  ${iterationHeader}
  <div style="background: white; padding: 15px; border-radius: 6px; margin-top: 15px;">
    ${reportContent}
  </div>
</div>`;

                      // Insert the WebNN report section at the top of the main content
                      detailHtml = detailHtml.replace(
                        /(<div[^>]*class="[^"]*test-case-column[^"]*"[^>]*>)/,
                        `$1${webnnReportSection}`
                      );

                      // Add the URL cleaning script before </body>
                      detailHtml = detailHtml.replace('</body>', `${urlCleanScript}</body>`);

                      // Write the modified HTML back
                      fs.writeFileSync(testPagePath, detailHtml, 'utf-8');

                      const testPageUrl = `file:///${testPagePath.replace(/\\/g, '/')}`;
                      console.log(`\n🔗 ${iterationPrefix}Direct link to WebNN Test Report:`);
                      console.log(`   ${testPageUrl}`);
                      console.log(`\n✅ ${iterationPrefix}WebNN Test Report is displayed at the top of the page`);
                    }
                  }
                }
              } else {
                console.log(`\n🔗 ${iterationPrefix}Open the report to view WebNN Test Report: ${timestampedFile}`);
              }
            } catch (error) {
              console.log(`⚠️  ${iterationPrefix}Error modifying report: ${error.message}`);
              console.log(`\n🔗 ${iterationPrefix}To view the report, open: ${timestampedFile}`);
            }

            // Clean up temp directory
            try {
              const deleteDirRecursive = (dirPath) => {
                if (fs.existsSync(dirPath)) {
                  fs.readdirSync(dirPath).forEach((file) => {
                    const curPath = path.join(dirPath, file);
                    if (fs.lstatSync(curPath).isDirectory()) {
                      deleteDirRecursive(curPath);
                    } else {
                      fs.unlinkSync(curPath);
                    }
                  });
                  fs.rmdirSync(dirPath);
                }
              };
              deleteDirRecursive(reportTempDir);
              console.log(`✅ ${iterationPrefix}Cleaned up temporary files`);
            } catch (error) {
              console.log(`⚠️  ${iterationPrefix}Error cleaning temp directory: ${error.message}`);
            }
          } catch (error) {
            console.log(`⚠️  ${iterationPrefix}Error copying report files: ${error.message}`);
            console.log(`📄 ${iterationPrefix}Report may be in: ${reportTempDir}`);
          }
        } else {
          console.log(`⚠️  ${iterationPrefix}Report file not found: ${tempIndexFile}`);
          console.log('Please check if tests completed successfully to generate the report.');
        }

        resolve(code);
      } else {
        console.log(`\n❌ ${iterationPrefix}Test iteration failed with code ${code}`);
        reject(code);
      }
    });
  });
}

// Main execution: run tests with repeat support
(async () => {
  try {
    const allResults = [];

    for (let i = 1; i <= repeat; i++) {
      const code = await runTestIteration(i, repeat);
      allResults.push({ iteration: i, exitCode: code });

      // Add a delay between iterations if repeating
      if (i < repeat) {
        console.log(`\n⏳ Waiting 2 seconds before next iteration...\n`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Summary of all iterations
    if (repeat > 1) {
      console.log(`\n${'='.repeat(80)}`);
      console.log(`📊 REPEAT SUMMARY - All ${repeat} iteration(s) completed`);
      console.log(`${'='.repeat(80)}`);
      allResults.forEach(result => {
        const status = result.exitCode === 0 ? '✅ PASS' : '❌ FAIL';
        console.log(`   Iteration ${result.iteration}: ${status}`);
      });
      console.log(`${'='.repeat(80)}\n`);
    }

    // Exit with 0 if all iterations passed, otherwise exit with 1
    const allPassed = allResults.every(r => r.exitCode === 0);
    process.exit(allPassed ? 0 : 1);
  } catch (error) {
    console.error(`❌ Error during test execution: ${error}`);
    process.exit(typeof error === 'number' ? error : 1);
  }
})();