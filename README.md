# WebNN Automation Tests

This project contains automated tests for WebNN (Web Neural Network) using Playwright.

## Prerequisites

1. **Chrome Canary**: Install Chrome Canary browser
2. **Node.js**: Install Node.js (version 16 or higher)
3. **Playwright**: Will be installed via npm
4. Install Windows App SDK
https://learn.microsoft.com/en-us/windows/apps/windows-app-sdk/downloads#experimental-release
5. Install IHV specific EPs
6. In powershell with admin priviledge, run DumpPackages.ps1 and search for WindowsMLRuntime

## Setup

1. Install dependencies:
```bash
npm install
```

2. Install Playwright browsers:
```bash
npx playwright install
```

## Running Tests

### Method 1: Using Node.js Script

```bash
# Run WPT tests (default)
node src/test.js

# Run specific test suite
node src/test.js --suite wpt
node src/test.js --suite sample
node src/test.js --suite preview

# Run multiple test suites (comma-separated, no spaces)
node src/test.js --suite "wpt,sample"
node src/test.js --suite "wpt,preview"
node src/test.js --suite "wpt,sample,preview"

# Run specific test cases
node src/test.js --suite wpt --wpt-case abs
node src/test.js --suite wpt --wpt-case arg_min
node src/test.js --suite sample --sample-case image-classification
node src/test.js --suite preview --preview-case image-classification

# Run multiple test cases (comma-separated)
node src/test.js --suite wpt --wpt-case abs,add
node src/test.js --suite wpt --wpt-case abs,add,arg_min

# Run with --ep flag to check ONNX Runtime DLLs
node src/test.js --suite wpt --wpt-case abs --ep
node src/test.js --suite wpt,sample --wpt-case abs --ep

# Run with parallel execution (use multiple jobs)
node src/test.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 2
node src/test.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 4

# Resume from where you left off (if tests were interrupted)
node src/test.js --suite wpt --wpt-case "add,sub,mul,div" --resume
node src/test.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 2 --resume
```

### Method 2: Using npm scripts

```bash
npm run test:wpt
npm run test:sample
npm run test:preview
```

### Method 3: Direct Playwright execution

```bash
# Set environment variable and run
$env:TEST_SUITE = "wpt"
npx playwright test --project=chromium-canary

# View report manually (static HTML file)
start report/index.html
```

## Test Cases

### WPT (Web Platform Tests)
- Visits `https://wpt.live/webnn/conformance_tests/`
- Discovers all `.js` test files with class "file"
- Converts each test from `xxx.js` to `xxx.html?gpu`
- Runs each test and collects results

### Sample
- Custom sample tests for WebNN functionality
- Image classification with EfficientNet model

### Preview (To be implemented)
- Preview tests for WebNN features

## Test Case Selection

Use suite-specific case options to run only tests that partially match the case string(s). You can specify multiple cases separated by commas (no spaces):

```bash
# Run only WPT tests containing "abs" in the name
node src/test.js --suite wpt --wpt-case abs
# This will run: abs.html?gpu

# Run only WPT tests containing "arg" in the name
node src/test.js --suite wpt --wpt-case arg
# This will run: arg_min_max.html?gpu, etc.

# Run multiple WPT cases - tests containing "abs" OR "add" (no spaces)
node src/test.js --suite wpt --wpt-case abs,add
# This will run: abs.html?gpu, add.html?gpu, etc.

# Run specific sample case
node src/test.js --suite sample --sample-case image-classification

# Run specific preview case
node src/test.js --suite preview --preview-case image-classification

# Run multiple suites with specific cases for one suite
node src/test.js --suite wpt,sample --wpt-case abs --ep
# This will run: WPT "abs" test + ALL sample tests + DLL check
```

The case selection is case-insensitive and matches any part of the test filename.

## Parallel Execution

Run multiple tests in parallel to speed up execution:

```bash
# Run with 2 parallel jobs
node src/test.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 2

# Run with 4 parallel jobs
node src/test.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 4

# The more jobs, the faster the execution (up to your CPU cores)
node src/test.js --suite wpt --jobs 8
```

**Benefits:**
- Significantly faster test execution
- Wall time vs sum of individual test times shows speedup
- Each test runs in isolated browser context

## Resume Functionality

If your test run is interrupted or quits in an unfinished state, you can resume from where you left off:

```bash
# First run (might be interrupted)
node src/test.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 2

# Resume from the last completed test
node src/test.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 2 --resume

# Works with both sequential and parallel execution
node src/test.js --suite wpt --wpt-case abs --resume
```

**How it works:**
- Progress is automatically saved after each test completes
- Checkpoint files are stored in `.checkpoint/` directory
- Use `--resume` flag to skip already completed tests
- Without `--resume`, tests start fresh (checkpoint is cleared)
- Each test case combination gets its own checkpoint file

**Example:**
```bash
# Start a test run with 10 tests
node src/test.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 2

# Press Ctrl+C after 5 tests complete

# Resume and continue from test 6
node src/test.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 2 --resume
# Output: "🔄 RESUME MODE: Found 5 completed test(s)"
#         "▶️  Resuming with 5 remaining test(s)"
```

**Note:** Checkpoint files are specific to the test case combination. Changing `--wpt-case` will use a different checkpoint file.

## Configuration

The tests run on Chrome Canary with the following flags:
- `--enable-features=WebMachineLearningNeuralNetwork,WebNNOnnxRuntime`
- `--disable-web-security`
- `--disable-features=VizDisplayCompositor`
- `--enable-unsafe-webgpu`

### Chrome Canary Path

The default Chrome Canary path is automatically detected. If you need to specify a custom path, set the `CHROME_CANARY_PATH` environment variable:

**Windows (PowerShell):**
```powershell
$env:CHROME_CANARY_PATH = "C:\path\to\chrome-canary.exe"
```

**Windows (Command Prompt):**
```cmd
set CHROME_CANARY_PATH=C:\path\to\chrome-canary.exe
```

**Linux/Mac:**
```bash
export CHROME_CANARY_PATH="/path/to/chrome-canary"
```

## Output

The test will output:
- Progress information for each test
- Summary of results (passed, failed, errors, unknown)
- Detailed information about failed tests
- **HTML report automatically opens in your default browser after tests complete**

### Manual Report Access
If you need to view the report again later:
```bash
# Open the static HTML file directly
start report/index.html
# or use npm script
npm run report
```

## Troubleshooting

1. **Chrome Canary not found**: Make sure Chrome Canary is installed and the path is correct
2. **Network issues**: Ensure you have internet access to reach `wpt.live`
3. **WebNN features not available**: Make sure you're using a recent version of Chrome Canary with WebNN support

## File Structure

```
webnn-test/
├── src/
│   ├── webnn.spec.js          # Main test file
│   ├── test.js                # Node.js test runner
│   └── clean-report.js        # Report post-processor
├── tools/                     # PowerShell utilities
├── package.json               # Node.js dependencies
├── playwright.config.js       # Playwright configuration
├── prepare.md                # Setup instructions
└── README.md                 # This file
```