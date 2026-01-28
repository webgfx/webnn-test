# WebNN Automation Tests

This project contains automated tests for WebNN (Web Neural Network) using Playwright.

## Prerequisites

1. **Chrome**: Install Chrome browser (stable, canary, dev, or beta)
2. **Node.js**: Install Node.js (version 16 or higher)
3. **Playwright**: Will be installed via npm

## Setup

1. Install dependencies:
```bash
npm install
```

## Running Tests

```bash
# Run all WPT tests (--suite wpt is default)
node src/main.js
node src/main.js --suite wpt

# Run specific WPT test case
node src/main.js --suite wpt --wpt-case abs

# Run multiple WPT test cases (comma-separated)
node src/main.js --suite wpt --wpt-case abs,add,mul

# Run with different Chrome channel (stable is default)
node src/main.js --suite wpt --chrome-channel canary
node src/main.js --suite wpt --chrome-channel dev
node src/main.js --suite wpt --chrome-channel beta

# Run with parallel execution (faster)
node src/main.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 4

# Run tests multiple times (repeat mode)
node src/main.js --suite wpt --wpt-case "add,sub" --repeat 3

# Combine options
node src/main.js --suite wpt --wpt-case "add,sub" --jobs 2 --repeat 3 --chrome-channel canary
```

## Test Case Selection

Use `--wpt-case` to run only tests that start string(s). Multiple cases can be specified separated by commas (no spaces):

```bash
# Run only tests with names starting with "abs"
node src/main.js --suite wpt --wpt-case abs

# Run tests with names starting with "abs" OR "add"
node src/main.js --suite wpt --wpt-case abs,add

# Run specific test indices (0-based)
node src/main.js --suite wpt --wpt-range 0,1,3-7
# This will run tests at indices 0, 1, 3, 4, 5, 6, 7 from the discovered list
```

The case selection is case-insensitive and matches the prefix of the test filename.

## Model Tests (Samples & Previews)

Run tests against WebNN samples and developer previews using the `model` suite:

```bash
# Run all model tests
node src/main.js --suite model

# Run specific model cases
node src/main.js --suite model --model-case lenet
node src/main.js --suite model --model-case sdxl,whisper
```

Available model cases include:
- `lenet`: LeNet Digit Recognition
- `segmentation`: Semantic Segmentation
- `style`: Fast Style Transfer
- `od`: Object Detection
- `ic`: Image Classification
- `sdxl`: SDXL Turbo
- `phi`: Phi-3 WebGPU
- `sam`: Segment Anything
- `whisper`: Whisper-base WebGPU

## Parallel Execution

Run multiple tests in parallel to speed up execution:

```bash
# Run with 2 parallel jobs
node src/main.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 2

# Run with 4 parallel jobs
node src/main.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 4

# Run with 8 parallel jobs
node src/main.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 8
```

## Repeat Mode

Run the entire test suite multiple times for stability testing:

```bash
# Run tests 3 times
node src/main.js --suite wpt --wpt-case "add,sub" --repeat 3

# Run with parallel execution, repeated 5 times
node src/main.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 2 --repeat 5
```

## Chrome Channel Selection

Switch between different Chrome channels using `--chrome-channel`:

```bash
# Use stable Chrome (default)
node src/main.js --suite wpt

# Use Chrome Canary
node src/main.js --suite wpt --chrome-channel canary

# Use Chrome Dev
node src/main.js --suite wpt --chrome-channel dev

# Use Chrome Beta
node src/main.js --suite wpt --chrome-channel beta
```

**Supported channels:** stable (default), canary, dev, beta

## Extra Browser Arguments

Pass extra arguments to the browser launch sequence using `--extra-browser-args`:

```bash
# Pass GPU selection flags
node src/main.js --suite wpt --extra-browser-args "--webnn-ort-ep-device=WebGpuExecutionProvider,0x8086,0x7d55"

# Pass multiple arguments
node src/main.js --suite wpt --extra-browser-args "--use-gl=angle --use-angle=gl"
```

## Test Reports

### HTML Report Generation

After test execution completes, an HTML report is automatically generated with:

- **WebNN Test Report Section**: Displays in attachments section at the bottom of the page with comprehensive test results
  - Test execution summary (passed, failed, error, unknown counts)
  - Detailed results for each test case with status and timing
  - Color-coded status indicators for easy identification
  - Test configuration information (suite, cases, jobs, etc.)

- **Playwright Report Details**: Contains detailed Playwright execution information
  - Individual test execution traces
  - Screenshots and videos (if configured)
  - Step-by-step test execution logs
  - Error details and stack traces for failed tests

### Report Files

Reports are saved in the `report/` directory:

- **Timestamped Reports**: Each test run generates a timestamped file (format: `YYYYMMDDHHMMSS.html`)
- **Iteration Reports**: When using `--repeat`, each iteration gets a suffix `_iter1`, `_iter2`, etc.
- **Direct Links**: The console output provides direct file:// links to view reports

### Viewing Reports

Reports are automatically opened in your default browser after test completion. To view reports manually:

```bash
# Open the report directory
start report/

# Open a specific report
start report/20251022143025.html

# Open an iteration report
start report/20251022143025_iter1.html
```
