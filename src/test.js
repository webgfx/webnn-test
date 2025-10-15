#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
let testSuite = 'wpt'; // default
let testCase = null;
let epFlag = false;
let jobs = 1; // default: run sequentially
let resumeFlag = false; // default: start fresh

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

// Find --ep argument
epFlag = args.includes('--ep');

// Find --resume argument
resumeFlag = args.includes('--resume');

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
if (testCase) {
  console.log(`Running specific case: ${testCase}`);
}
if (jobs > 1) {
  console.log(`Parallel execution enabled: ${jobs} job(s)`);
}
if (resumeFlag) {
  console.log('🔄 Resume mode enabled: Will skip already completed tests');
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
process.env.RESUME = resumeFlag ? 'true' : 'false';

// Run Playwright test with config path
const configPath = path.join(__dirname, '..', 'playwright.config.js');
const playwrightArgs = [
  'test',
  `--config=${configPath}`,
  '--project=chromium-canary',
  ...args.filter(arg =>
    arg !== '--suite' &&
    arg !== testSuite &&
    arg !== '--wpt-case' &&
    arg !== '--sample-case' &&
    arg !== '--preview-case' &&
    arg !== testCase &&
    arg !== '--ep' &&
    arg !== '--resume' &&
    arg !== '--jobs' &&
    arg !== jobs.toString()
  ) // Remove suite-specific arguments
];

const playwrightProcess = spawn('npx', ['playwright', ...playwrightArgs], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env }
});

playwrightProcess.on('close', (code) => {
  if (code === 0) {
    console.log('\n✅ Test completed successfully');

    const fs = require('fs');
    const path = require('path');
    const { execSync } = require('child_process');

    // Find the HTML report file (in temp directory)
    const reportTempDir = path.join(__dirname, '..', 'report-temp');
    const reportDir = path.join(__dirname, '..', 'report');
    const tempIndexFile = path.join(reportTempDir, 'index.html');

    // Ensure report directory exists
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    if (fs.existsSync(tempIndexFile)) {
      // Generate timestamped filename YYYYMMDDHHMMSS
      const now = new Date();
      const timestamp = now.getFullYear().toString() +
                       (now.getMonth() + 1).toString().padStart(2, '0') +
                       now.getDate().toString().padStart(2, '0') +
                       now.getHours().toString().padStart(2, '0') +
                       now.getMinutes().toString().padStart(2, '0') +
                       now.getSeconds().toString().padStart(2, '0');

      const indexFile = path.join(reportDir, 'index.html');
      const timestampedFile = path.join(reportDir, `${timestamp}.html`);

      // Copy temp report to both index.html and timestamped file
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

        console.log('✅ HTML report generated');

        // Rename index.html to timestamped file (no need to keep index.html)
        fs.renameSync(indexFile, timestampedFile);
        console.log(`📄 Timestamped report: ${timestampedFile}`);

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

                  // Create a wrapper for the WebNN report at the top
                  const webnnReportSection = `
<div style="margin: 20px 0; padding: 20px; background: #f8f9fa; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px;">📊 WebNN Test Report</h2>
  <div style="background: white; padding: 15px; border-radius: 6px; margin-top: 15px;">
    ${reportContent}
  </div>
</div>`;

                  // Insert the WebNN report section at the top of the main content
                  // Find the main content area (after the header)
                  detailHtml = detailHtml.replace(
                    /(<div[^>]*class="[^"]*test-case-column[^"]*"[^>]*>)/,
                    `$1${webnnReportSection}`
                  );

                  // Add the URL cleaning script before </body>
                  detailHtml = detailHtml.replace('</body>', `${urlCleanScript}</body>`);

                  // Write the modified HTML back
                  fs.writeFileSync(testPagePath, detailHtml, 'utf-8');

                  const testPageUrl = `file:///${testPagePath.replace(/\\/g, '/')}`;
                  console.log(`\n🔗 Direct link to WebNN Test Report:`);
                  console.log(`   ${testPageUrl}`);
                  console.log(`\n✅ WebNN Test Report is displayed at the top of the page`);
                }
              }
            }
          } else {
            console.log(`\n🔗 Open the report to view WebNN Test Report: ${timestampedFile}`);
          }
        } catch (error) {
          console.log(`⚠️ Error modifying report: ${error.message}`);
          console.log(`\n🔗 To view the report, open: ${timestampedFile}`);
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
          console.log('✅ Cleaned up temporary files');
        } catch (error) {
          console.log(`⚠️ Error cleaning temp directory: ${error.message}`);
        }
      } catch (error) {
        console.log(`⚠️ Error copying report files: ${error.message}`);
        console.log(`📄 Report may be in: ${reportTempDir}`);
      }
    } else {
      console.log(`⚠️ Report file not found: ${tempIndexFile}`);
      console.log('Please check if tests completed successfully to generate the report.');
    }
  }
  process.exit(code);
});