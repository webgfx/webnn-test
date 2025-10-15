import { defineConfig, devices } from '@playwright/test';

/**
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './src',
  testMatch: '**/*.spec.js',
  /* Test timeout - 10 minutes for WebNN tests */
  timeout: 600000, // 10 minutes
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    ['html', {
      open: 'never',
      outputFolder: 'report-temp'
    }]
  ],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    // baseURL: 'http://127.0.0.1:3000',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',

    /* Make browser visible during test execution */
    headless: false,
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium-canary',
      use: {
        ...devices['Desktop Chrome'],
        // Use Chrome Canary with WebNN features enabled
        launchOptions: {
          executablePath: process.env.CHROME_CANARY_PATH || 'C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe',
          args: [
            '--enable-features=WebMachineLearningNeuralNetwork,WebNNOnnxRuntime',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--enable-unsafe-webgpu'
          ]
        }
      },
    },
  ],

  /* Run your local dev server before starting the tests */
  // webServer: {
  //   command: 'npm run start',
  //   url: 'http://127.0.0.1:3000',
  //   reuseExistingServer: !process.env.CI,
  // },
});