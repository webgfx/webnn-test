#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
let testSuite = 'wpt'; // default
let testCase = null;
let epFlag = false;

// Find --suite argument
const suiteIndex = args.findIndex(arg => arg === '--suite');
if (suiteIndex !== -1 && suiteIndex + 1 < args.length) {
  testSuite = args[suiteIndex + 1];
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
    arg !== '--ep'
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
    
    // Find the HTML report file (in parent directory)
    const reportDir = path.join(__dirname, '..', 'report');
    const indexFile = path.join(reportDir, 'index.html');
    
    if (fs.existsSync(indexFile)) {
      // Clean up the report to hide Test Steps
      try {
        console.log('🧹 Cleaning up HTML report...');
        const cleanReportPath = path.join(__dirname, 'clean-report.js');
        execSync(`node "${cleanReportPath}"`, { stdio: 'inherit' });
      } catch (error) {
        console.log('⚠️ Could not clean report, but report was generated');
      }
      
      console.log('✅ HTML report generated');
      console.log(`📄 Report path: ${indexFile}`);
      
      // Read the HTML to find the WebNN Test Report attachment link
      try {
        const htmlContent = fs.readFileSync(indexFile, 'utf-8');
        
        // Try to extract the test result page link
        // Playwright generates links like: data/abc123.html for each test
        const testPageMatch = htmlContent.match(/href="(data\/[a-f0-9]+\.html)"/);
        
        if (testPageMatch) {
          const testPagePath = path.join(reportDir, testPageMatch[1]);
          const testPageUrl = `file:///${testPagePath.replace(/\\/g, '/')}`;
          
          console.log(`\n🔗 Direct link to WebNN Test Report:`);
          console.log(`   ${testPageUrl}#attachments`);
          console.log(`\n💡 Tip: The WebNN-Test-Report attachment is displayed at the top of the test page.`);
        } else {
          console.log(`\n🔗 Open the report to view WebNN Test Report: ${indexFile}`);
        }
      } catch (error) {
        console.log(`\n🔗 To view the report, open: ${indexFile}`);
      }
    } else {
      console.log(`⚠️ Report file not found: ${indexFile}`);
      console.log('Please check if tests completed successfully to generate the report.');
    }
  }
  process.exit(code);
});