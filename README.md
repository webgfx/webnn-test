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

# Run tests multiple times (repeat mode)
node src/test.js --suite wpt --wpt-case "add,sub" --repeat 3
node src/test.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 2 --repeat 5

# Combine all options
node src/test.js --suite wpt --wpt-case "add,sub" --jobs 2 --repeat 3 --ep
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

## Repeat Mode

Run the entire test suite multiple times for stability testing or performance analysis:

```bash
# Run tests 3 times
node src/test.js --suite wpt --wpt-case "add,sub" --repeat 3

# Run with parallel execution, repeated 5 times
node src/test.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 2 --repeat 5

# Combine with all options
node src/test.js --suite wpt --wpt-case "add" --jobs 4 --repeat 10 --ep
```

**How it works:**
- 🔁 **Independent iterations**: Each iteration is a standalone test run
- 🧹 **Fresh start**: Checkpoint cleared before each iteration
- 📊 **Separate reports**: Each iteration gets its own timestamped report with `_iterN` suffix
- ⏱️ **2-second delay**: Brief pause between iterations for stability
- 📈 **Summary**: Shows pass/fail status for all iterations at the end

**Example output:**
```bash
node src/test.js --suite wpt --wpt-case "add,sub" --repeat 3

# Output:
================================================================================
🔁 ITERATION 1/3
================================================================================
# ... tests run ...
✅ [Iteration 1/3] Test iteration completed successfully
📄 [Iteration 1/3] Timestamped report: report/20251016143025_iter1.html

⏳ Waiting 2 seconds before next iteration...

================================================================================
🔁 ITERATION 2/3
================================================================================
# ... tests run ...
✅ [Iteration 2/3] Test iteration completed successfully
📄 [Iteration 2/3] Timestamped report: report/20251016143142_iter2.html

⏳ Waiting 2 seconds before next iteration...

================================================================================
🔁 ITERATION 3/3
================================================================================
# ... tests run ...
✅ [Iteration 3/3] Test iteration completed successfully
📄 [Iteration 3/3] Timestamped report: report/20251016143258_iter3.html

================================================================================
📊 REPEAT SUMMARY - All 3 iteration(s) completed
================================================================================
   Iteration 1: ✅ PASS
   Iteration 2: ✅ PASS
   Iteration 3: ✅ PASS
================================================================================
```

**Use cases:**
- 🎯 **Stability testing**: Verify tests pass consistently across multiple runs
- 📊 **Performance analysis**: Compare execution times across iterations
- 🐛 **Flakiness detection**: Identify intermittent failures
- 🔬 **Stress testing**: Run tests repeatedly to catch edge cases

## Automatic Checkpoint & Resume

The test runner automatically saves progress and resumes from where it left off if interrupted:

**How it works:**
- ✅ **Automatic**: No flags needed - resume is always enabled
- 💾 **Progress saved**: Checkpoint saved after each test completes
- 🔄 **Auto-resume**: Next run automatically skips completed tests
- 📁 **Checkpoint files**: Stored in `.checkpoint/` directory (git-ignored)
- 🎯 **Test-specific**: Each test case combination has its own checkpoint
- 🧹 **Clean slate**: Delete `.checkpoint/` folder to start completely fresh

**Example:**
```bash
# Start a test run with 10 tests
node src/test.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 2
# Tests 1-5 complete...
# Press Ctrl+C to interrupt

# Run again - automatically resumes
node src/test.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 2
# Output: "🔄 AUTO-RESUME: Found 5 completed test(s) from previous run"
#         "▶️  Resuming with 5 remaining test(s)"
# Continues from test 6...
```

**Smart retry logic:**
- ✅ **PASS/FAIL results**: Saved to checkpoint (won't re-run)
- ⚠️ **ERROR/UNKNOWN results**: NOT saved (will retry on next run)
- 🔁 **Failed tests**: Retry until 2 consecutive identical failures seen
- ⏱️ **Wall time**: Accumulated across all sessions

**To start completely fresh:**
```bash
# Delete checkpoint folder
Remove-Item -Recurse -Force .checkpoint
# or on Linux/Mac:
rm -rf .checkpoint

# Run tests
node src/test.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 2
```

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