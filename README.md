# WebNN Automation Tests

This project contains automated tests for WebNN (Web Neural Network) using Playwright.

## Prerequisites

1. **Browser**: Install Chrome or Microsoft Edge (stable, canary, dev, or beta)
2. **Node.js**: Install Node.js (version 16 or higher)
3. **Playwright**: Will be installed via npm

## Setup

1. Install dependencies:
```bash
npm install
```

## Running Tests

```bash
# Run with configuration file
node src/main.js --config config/example.json

# Run all WPT tests (--suite wpt is default)
node src/main.js
node src/main.js --suite wpt

# Run specific WPT test case
node src/main.js --suite wpt --wpt-case abs

# Run multiple WPT test cases (comma-separated)
node src/main.js --suite wpt --wpt-case abs,add,mul

# Run with different Chrome channel (Canary is default)
node src/main.js --suite wpt --chrome-channel canary
node src/main.js --suite wpt --chrome-channel dev
node src/main.js --suite wpt --chrome-channel beta

# Run the WebNN CTS with Edge Canary
node src/main.js --suite wpt --browser edge --browser-channel canary

# Run with parallel execution (faster)
node src/main.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 4

# Run tests multiple times (repeat mode)
node src/main.js --suite wpt --wpt-case "add,sub" --repeat 3

# Combine options
node src/main.js --suite wpt --wpt-case "add,sub" --jobs 2 --repeat 3 --chrome-channel canary
```

## Configuration File

Use `--config` to run tests defined in a JSON file. This allows defining complex test suites with specific devices and browser arguments.

```bash
node src/main.js --config config/example.json
```

Example configuration format:
```json
[
    {
        "name": "ORT WPT",
        "browser-arg": "--enable-features=WebNNOnnxRuntime",
        "suite": "wpt",
        "wpt-case": "add",
        "device": "cpu,gpu"
    }
]
```

Model suite entries also accept `"model-case"` and `"model-variants"` (`default`
or `all`); a `--model-variants` command-line argument overrides the file.

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

Run tests against [WebNN Samples](https://webmachinelearning.github.io/webnn-samples/)
and the [WebNN Developer Preview](https://microsoft.github.io/webnn-developer-preview/)
using the `model` suite:

```bash
# Run all model tests (one representative variant per case)
node src/main.js --suite model

# Run specific model cases
node src/main.js --suite model --model-case lenet
node src/main.js --suite model --model-case sdxl,whisper
node src/main.js --suite model --model-case stem --device npu

# Run specific variants of a case (key:variantA+variantB)
node src/main.js --suite model --model-case od:ssdmobilenetv1-fp16,ic:mobilenet-v2+efficientnet-lite4

# Run every variant of every case, or of selected cases
node src/main.js --suite model --model-variants all
node src/main.js --suite model --model-case ic-sample,style --model-variants all
node src/main.js --config config/model-full.json

# List cases, supported devices, and variants (the default variant is marked)
node src/main.js --suite model --list
```

| Case | Sample | Devices | Variants (default first) |
|---|---|---|---|
| `lenet` | LeNet digit recognition | cpu, gpu | - |
| `segmentation` | Semantic Segmentation (DeepLab V3 MobileNet V2) | cpu, gpu | - |
| `style` | Fast Style Transfer | cpu, gpu | 9 styles: `starry-night`, `self-portrait`, `bedroom`, ... |
| `od` | Object Detection | cpu, gpu, npu | `tinyyolov2-fp32` (`tinyyolov2-fp16` on NPU), `ssdmobilenetv1-fp32`/`-fp16` |
| `ic-sample` | Image Classification | cpu, gpu, npu | `mobilenet-fp32` (`mobilenet-fp16` on NPU), `mobilenet-uint8`, `squeezenet-fp32`, `resnet50v2-*`, `resnet50v1-fp16`, `efficientnet-fp16` |
| `nsnet2` | Noise Suppression (NSNet2) | cpu, gpu | - |
| `rnnoise` | Noise Suppression (RNNoise) | cpu, gpu | - |
| `selfie` | Selfie Segmentation | cpu, gpu, npu | `general-fp16`, `general-fp32`, `landscape-fp16`, `landscape-fp32` |
| `fld` | Facial Landmark Detection | cpu, gpu | - |
| `fr` | Face Recognition | cpu, gpu | - |
| `ic` | Preview Image Classification | cpu, gpu, npu | `resnet-50`, `mobilenet-v2`, `efficientnet-lite4` |
| `sam` | Preview Segment Anything | cpu, gpu, npu | `sam_b`, `sam_b_int8` |
| `whisper` | Preview Whisper Base | cpu, gpu, npu | `float16`, `float32` |
| `stem` | Preview Stem Separator | gpu, npu | - |
| `sdxl` | Preview SDXL Turbo | gpu | - |
| `sd15` | Preview Stable Diffusion 1.5 | gpu, npu | - |
| `sdturbo` | Preview SD-Turbo | gpu, npu | - |
| `phi` | Preview Text Generation | cpu, gpu, npu | `phi4mini`, `tinyllama`, `qwen2`, `deepseekr1` |
| `zimage` | Preview Z-Image-Turbo (**opt-in**) | gpu | `512`, `1024` |

Variant selection:

- Without `--model-case`, every case except opt-in ones runs. `zimage` is opt-in
  because it is unfinished upstream (not linked from the index; NPU unsupported).
  Run it with `--model-case zimage`.
- A bare case key runs its default variant; `--model-variants all` (or
  `"model-variants": "all"` in a config file) runs all of them. `key:a+b` runs
  the named variants regardless of `--model-variants`.
- Each variant is reported as its own result, e.g. `Object Detection [SSD MobileNet V1 / float16]`.
- A case or variant run on a device it does not support is reported as `SKIP`
  with the reason, as is a variant the sample hides for the device (for example
  `mobilenet-uint8` when the device prefers the NCHW layout, or float32 on NPU).
  A supported device that fails is reported as a failure, never a `SKIP`.

What each case verifies, beyond the page reporting timings:

- Classification (`ic-sample`, `ic`, `lenet`): the top-1 class for the sample's
  default image (`lesser panda`, `tiger`) or for a pinned MNIST digit.
- Detection and faces (`od`, `fld`, `fr`): boxes, labels, and keypoints captured
  from the output canvas (a `person` detection; 2 faces with 68 landmarks each;
  all 4 search faces matched to distinct target faces).
- Segmentation and images (`segmentation`, `selfie`, `style`, `sam`, `sdxl`,
  `sd15`, `sdturbo`, `zimage`): the output is not blank, the `person` class is
  present, the foreground/mask covers a plausible area, or the style changed the image.
- Audio (`nsnet2`, `rnnoise`): the denoised audio keeps the input's duration and
  speech envelope while removing energy.
- Text (`phi`): a non-degenerate response that answers "What is 2 + 2?" (`qwen2`
  is only checked for a coherent response).
- Data types (`ic-sample`, `od`, `selfie`): the graph's constants include the
  selected data type, so a sample that ignores the selection fails instead of
  silently running another precision.
- Previews: `[WebNN:Perf]` entries prove sessions and inference ran on WebNN with
  the requested device, so a silent fallback to WASM or WebGPU fails.

### Adding a sample

Register a case in `ModelRunner.models` in `src/model.js` with its name, URL,
type (`sample` or `preview`), supported `devices`, and runner method. Add
`variants` (id -> `{ label, devices?, ... }`) with a `defaultVariant` (an id, or
`{ default, npu }` per device) when the sample offers several models or data
types; set `optIn: true` to exclude it from default runs and `timeoutMs` for long
downloads. Implement the method in the same class: it receives `(results,
caseDef, variant)` where `caseDef.name` already includes the variant label.
Select the requested device explicitly, drive the sample's normal UI, verify
actual output, and append the standard result object (`testName`, `testUrl`,
`result`, `details`, `subcases`, `suite: 'model'`). Throw on failure;
`runModelTests` records the error. Use the shared helpers (`openSample`,
`selectSampleDevice`, `waitForSampleResult`, `installCanvasCapture`,
`imageStats`, `watchConsoleErrors`, `checkPerf`) and keep output validators as
pure exported functions. For instrumented previews, start a `WebNNPerfCollector`
before navigation, include `perfMetrics`/`perfSummary` in the result, and stop it
in `finally`.

The case is automatically included in `--suite model`, `--model-case`, `--list`,
and reports; no separate Playwright project is needed. Add focused regression
tests under `tests/` and run them with `node --test tests\*.unit.cjs`.

Stem Separator separates `assets/test.wav` into drums, bass, other, and vocals,
then validates the downloaded WAVs and checks that the stems add back up to the
input mix (relative MAE within 10%). It runs only on the requested WebNN device;
CPU runs are reported as `SKIP` because the sample has no WebNN CPU backend.

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

## Browser Selection

Run the WebNN CTS (the WPT conformance suite) with Chrome or Microsoft Edge:

```bash
# Chrome Canary (default)
node src/main.js --suite wpt

# Edge Canary
node src/main.js --suite wpt --browser edge

# Edge stable
node src/main.js --suite wpt --browser edge --browser-channel stable
```

**Supported browsers:** chrome (default), edge

**Supported channels:** canary (default), stable, dev, beta

The older `--chrome-channel` option remains available as an alias for `--browser-channel`.

## Browser Channel Selection

Switch between Chrome and Edge channels using `--browser-channel`:

```bash
# Use stable Chrome
node src/main.js --suite wpt --browser-channel stable

# Use Chrome Canary
node src/main.js --suite wpt --browser-channel canary

# Use Chrome Dev
node src/main.js --suite wpt --browser-channel dev

# Use Chrome Beta
node src/main.js --suite wpt --browser-channel beta

# Run an Edge Canary smoke test using the latest installed preview/experimental SDK
node src/main.js --suite wpt --wpt-case "abs,add" --device cpu,gpu --jobs 1 --browser edge --browser-channel canary --skip-retry
```

**Supported channels:** canary (default), stable, dev, beta

On Windows, test runs select the latest installed **preview or experimental**
Windows App SDK for the runner's architecture and enable `WebNNOnnxRuntime` by
default. Selection compares the SDK generation before the numeric package version,
so older 1.x packages with `8000.x` versions do not outrank 2.x releases. If none is
installed, the run stops with an installation hint. Help and test listing do not
require an SDK. This selects installed packages; it does not download updates.

Selection uses Chromium's `--webnn-ort-library-path-for-testing` override with
`--allow-third-party-modules`. After each configuration, the runner verifies the
loaded `onnxruntime.dll` path and fails if it cannot confirm the selected runtime.
This selects the ONNX Runtime library; EP packages remain selected by the browser.

## Browser Arguments

Pass extra arguments to the browser launch sequence using `--browser-arg`:

```bash
# Pass GPU selection flags
node src/main.js --suite wpt --browser-arg "--webnn-ort-ep-device=WebGpuExecutionProvider,0x8086,0x7d55"

# Pass multiple arguments
node src/main.js --suite wpt --browser-arg "--use-gl=angle --use-angle=gl"
```

## Skip Retry

By default, failed WPT test cases are retried automatically. Use `--skip-retry` to disable this behavior:

```bash
# Run without retrying failed cases
node src/main.js --suite wpt --skip-retry
```

## Timeouts

Model cases run under a per-case watchdog that aborts the case and restarts the browser if it hangs: 600 seconds by default, and 30 to 90 minutes for previews that download multi-GB models (text generation, SDXL, Stable Diffusion 1.5, SD-Turbo, Z-Image-Turbo). `--model-timeout` replaces the watchdog for every model case. WPT test files have a separate per-test limit (default 60 seconds). Override either in seconds:

```bash
# Allow slow model cases up to 30 minutes each
node src/main.js --suite model --model-timeout 1800

# Allow each WPT test file up to 3 minutes
node src/main.js --suite wpt --wpt-timeout 180
```

## WPT Server

WPT tests are loaded from `https://wpt.live` by default. Use `--wpt-base-url` to point at another WPT server root, such as a local `wpt serve` instance when wpt.live is unreachable or throttled:

```bash
node src/main.js --suite wpt --wpt-base-url http://localhost:8000
```

The harness appends `/webnn/conformance_tests/` to the URL (a full conformance_tests URL is also accepted). Test discovery relies on the wptserve directory listing, so the server must be `wpt serve` rather than a generic static file server. WebNN requires a secure context, so use `localhost` or HTTPS.

## Email Report

Send test results via email after completion using `--email`:

```bash
# Send to default address
node src/main.js --suite wpt --email

# Send to a specific address
node src/main.js --suite wpt --email user@example.com
```

> **Note:** The email feature requires **Classic Outlook** to be installed on the machine. The new Outlook app does not support COM automation. If `--email` fails, install Classic Outlook from:
> https://support.microsoft.com/en-us/office/install-or-reinstall-classic-outlook-on-a-windows-pc-5c94902b-31a5-4274-abb0-b07f4661edf5

## Baseline Comparison

Test results can be compared against a previous run (baseline) to detect regressions and improvements at both the case level and subcase level. By default, the most recent results directory containing a text report is used as the baseline.

Use `--baseline` to specify a particular baseline folder:

```bash
# Compare against a specific baseline
node src/main.js --suite wpt --baseline bl-20260209172945

# Compare against a previous run by timestamp
node src/main.js --suite wpt --baseline 20260208120000
```

Baseline directories are looked up under the `results/` folder. Directories prefixed with `bl-` are preferred over regular timestamp directories when auto-selecting a baseline.

## Test Reports

### HTML Report Generation

After test execution completes, an HTML report is automatically generated with:

- **WebNN Test Report Section**: Displays in attachments section at the bottom of the page with comprehensive test results
  - Runtime Information at the top lists ORT, Windows App SDK, and execution provider (EP) versions used by the run, with EP package and DLL versions when available; the text report includes the same snapshot
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

Reports are saved in the `results/` directory:

- **Timestamped Reports**: Each test run generates a timestamped file (format: `YYYYMMDDHHMMSS.html`)
- **Iteration Reports**: When using `--repeat`, each iteration gets a suffix `_iter1`, `_iter2`, etc.
- **Direct Links**: The console output provides direct file:// links to view reports

### Viewing Reports

Reports are automatically opened in your default browser after test completion. To view reports manually:

```bash
# Open the report directory
start results/

# Open a specific report
start results/20251022143025.html

# Open an iteration report
start results/20251022143025_iter1.html
```
