# Resume Feature Guide

## Overview

The resume feature allows you to continue test execution from where you left off if your test run is interrupted. This is especially useful for:
- Long-running test suites
- Network interruptions
- System crashes or restarts
- Intentional test cancellations

## How to Use

### Basic Usage

1. **Start your test run normally:**
   ```bash
   node src/test.js --suite wpt --wpt-case "add,sub,mul,div,abs" --jobs 2
   ```

2. **If interrupted (Ctrl+C, crash, etc.), resume with the `--resume` flag:**
   ```bash
   node src/test.js --suite wpt --wpt-case "add,sub,mul,div,abs" --jobs 2 --resume
   ```

### Resume Output and Report Generation

When you use `--resume`, you'll see:

```
🔄 Resume mode enabled: Will skip already completed tests
...
🔄 RESUME MODE: Found 3 completed test(s)
📋 Completed tests: add.https.any.js, sub.https.any.js, mul.https.any.js
✅ Skipping 3 completed test(s)
▶️  Resuming with 2 remaining test(s)
...
✅ Completed parallel execution of cases: add, sub, mul, div, abs

📊 Total Summary (including 3 previously completed test(s)):
   Previously completed: 3
   Newly executed: 2
   Total: 5
⏱️  Wall time (this session): 16.8s
⏱️  Sum of individual test times (all tests): 42.1s
⚡ Parallel speedup (this session): 2.1x
```

**Important:** The final HTML report will include ALL tests (both previously completed and newly run), giving you a complete picture of all test results.

### Important Notes

1. **Checkpoint files are case-specific:**
   - Stored in `.checkpoint/` directory
   - Named based on your `--wpt-case` value
   - Example: `.checkpoint/wpt_checkpoint_add_sub_mul_div.json`

2. **Starting fresh:**
   - Without `--resume` flag, checkpoint is automatically cleared
   - Tests start from the beginning

3. **Checkpoint file format:**
   ```json
   {
     "completedTests": [
       "add.https.any.js",
       "sub.https.any.js"
     ],
     "completedResults": [
       {
         "testName": "add",
         "testUrl": "https://wpt.live/webnn/conformance_tests/add.https.any.html?gpu",
         "result": "PASS",
         "subcases": { "total": 100, "passed": 100, "failed": 0 },
         "executionTime": "8.42",
         "suite": "wpt"
       },
       {
         "testName": "sub",
         "testUrl": "https://wpt.live/webnn/conformance_tests/sub.https.any.html?gpu",
         "result": "PASS",
         "subcases": { "total": 100, "passed": 100, "failed": 0 },
         "executionTime": "8.38",
         "suite": "wpt"
       }
     ],
     "lastUpdated": "2025-10-15T10:30:00.000Z",
     "testCase": "add,sub,mul,div"
   }
   ```

   **Note:** The checkpoint file now stores complete test results, not just test names. This allows the final report to include all test data when resuming.

## Examples

### Example 1: Parallel Execution with Resume

```bash
# Start with 4 parallel jobs
node src/test.js --suite wpt --wpt-case "add,sub,mul,div,abs,relu" --jobs 4

# Interrupted after 3 tests complete
# Press Ctrl+C

# Resume with same configuration
node src/test.js --suite wpt --wpt-case "add,sub,mul,div,abs,relu" --jobs 4 --resume
```

### Example 2: Sequential Execution with Resume

```bash
# Start sequential run
node src/test.js --suite wpt --wpt-case "add,sub,mul"

# Interrupted after 1 test
# Press Ctrl+C

# Resume
node src/test.js --suite wpt --wpt-case "add,sub,mul" --resume
```

### Example 3: Changing Job Count

```bash
# Start with 2 jobs
node src/test.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 2

# Interrupted
# Press Ctrl+C

# Resume with 4 jobs (still works!)
node src/test.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 4 --resume
```

### Example 4: Verify Completion and View Complete Report

```bash
# Resume and complete all tests
node src/test.js --suite wpt --wpt-case "add,sub,mul" --resume

# If all tests were already done:
# Output: "✅ All tests already completed!"
# Report will still be generated with all results from checkpoint
```

**Key Feature:** Even if all tests are already completed, the resume mode will generate a complete HTML report with all the test results from the checkpoint file.

## Checkpoint Management

### Manual Checkpoint Management

If you need to manually inspect or clear checkpoints:

```bash
# View checkpoint files
dir .checkpoint

# View checkpoint content (PowerShell)
Get-Content .checkpoint/wpt_checkpoint_add_sub_mul.json | ConvertFrom-Json

# Clear specific checkpoint
Remove-Item .checkpoint/wpt_checkpoint_add_sub_mul.json

# Clear all checkpoints
Remove-Item .checkpoint/* -Force
```

## Troubleshooting

### Issue: Resume doesn't skip any tests

**Cause:** Checkpoint file doesn't exist or test case name changed

**Solution:**
- Verify you're using the exact same `--wpt-case` value
- Check if `.checkpoint/` directory exists
- Look for matching checkpoint file

### Issue: Tests are skipped but shouldn't be

**Cause:** Old checkpoint from previous run

**Solution:**
- Run without `--resume` flag to start fresh
- Or manually delete the checkpoint file

### Issue: Checkpoint not saved after test completion

**Cause:** Write permission issue or disk full

**Solution:**
- Check if `.checkpoint/` directory is writable
- Ensure sufficient disk space
- Check console for warning messages

## Advanced Usage

### Combining with Other Flags

```bash
# Resume with --ep flag (DLL check)
node src/test.js --suite wpt --wpt-case abs --resume --ep

# Resume with multiple suites
node src/test.js --suite wpt,sample --wpt-case abs --resume
```

### Custom Checkpoint Location

Currently, checkpoints are stored in `.checkpoint/` directory in the project root. This directory is automatically created if it doesn't exist.

## Best Practices

1. **Always use the same test case specification when resuming**
   - ✅ `--wpt-case "add,sub"` → resume with `--wpt-case "add,sub"`
   - ❌ `--wpt-case "add,sub"` → resume with `--wpt-case "sub,add"` (different order = different checkpoint)

2. **Don't modify checkpoint files manually**
   - Let the system manage them
   - If needed, delete and start fresh

3. **Clear checkpoints periodically**
   - Old checkpoints don't expire automatically
   - Clean up `.checkpoint/` directory occasionally

4. **Use resume for long test runs**
   - Most beneficial for runs with many tests
   - Less overhead for short test runs

## Technical Details

- Checkpoints are saved after EACH test completes (not in batches)
- **Complete test results** are stored in checkpoint files (including pass/fail counts, execution times, etc.)
- Works in both parallel and sequential modes
- File-based checkpoint system (JSON format)
- Checkpoint filename derived from test case name
- Thread-safe for parallel execution
- Minimal performance overhead
- **Final report merges all results**: Previously completed tests + newly run tests = complete report

### Report Generation with Resume

When using `--resume`, the generated HTML report includes:
- All previously completed tests (loaded from checkpoint)
- All newly executed tests (from current session)
- Combined statistics and success rates
- Execution times for all tests
- Complete test coverage view

This ensures you always get a comprehensive report showing the full test suite results, even when tests are executed across multiple sessions.
