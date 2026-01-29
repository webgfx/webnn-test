
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('@playwright/test');


async function send_email(subject, content, sender = '', to = '') {
    // Create PowerShell script to send email via Outlook
    const powershellScript = `
try {
    $outlook = New-Object -ComObject Outlook.Application
    $mail = $outlook.CreateItem(0)  # olMailItem = 0

    $mail.Subject = "${subject}"
    $mail.HTMLBody = @'
${content}
'@

    # Set recipient
    ${to ? `$mail.To = "${to}"` : ''}
    ${sender ? `$mail.SentOnBehalfOfName = "${sender}"` : ''}

    # Send the email automatically
    $mail.Send()

    Write-Host "Email sent successfully${to ? ' to ' + to : ''}"
    exit 0
} catch {
    Write-Host "Error sending email: $($_.Exception.Message)"
    exit 1
}`;

    const tempDir = os.tmpdir();
    const scriptPath = path.join(tempDir, `send-email-${Date.now()}.ps1`);

    try {
      // Write with BOM to ensure PowerShell reads it correctly as UTF-8
      fs.writeFileSync(scriptPath, '\ufeff' + powershellScript, 'utf8');

      return new Promise((resolve, reject) => {
        const powershell = require('child_process').spawn('powershell.exe', [
          '-ExecutionPolicy', 'Bypass',
          '-File', scriptPath
        ], {
          stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        powershell.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        powershell.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        powershell.on('close', (code) => {
          // Clean up temp file
          try {
            if (fs.existsSync(scriptPath)) {
              fs.unlinkSync(scriptPath);
            }
          } catch (e) {
            console.log('Note: Could not clean up temporary file:', e.message);
          }

          if (code === 0) {
            resolve(stdout.trim());
          } else {
            console.error('Failed to send email:', stderr.trim());
            reject(new Error(`PowerShell exited with code ${code}: ${stderr}`));
          }
        });

        powershell.on('error', (error) => {
          reject(error);
        });
      });

    } catch (error) {
      console.error('Error in send_email:', error);
      throw error;
    }
  }

  function _format_driver_date(dateString) {
    if (!dateString) return '';
    let datePart = dateString.toString().trim().split(/\s+/)[0];
    datePart = datePart.replace(/-/g, '/').replace(/\./g, '/');

    if (datePart.includes('/')) {
        const parts = datePart.split('/');
        if (parts.length === 3) {
            if (parts[0].length === 4 && !isNaN(parts[0])) {
                // YYYY/M/D -> YYYYMMDD
                return `${parts[0]}${parts[1].padStart(2, '0')}${parts[2].padStart(2, '0')}`;
            } else {
                // M/D/YYYY -> YYYYMMDD
                return `${parts[2]}${parts[0].padStart(2, '0')}${parts[1].padStart(2, '0')}`;
            }
        }
    }
    return datePart.replace(/\//g, '');
  }

  function _is_hardware_gpu(gpu) {
    const name = gpu.Name || '';
    const pnp = gpu.PNPDeviceID || '';
    const status = gpu.Status || '';
    if (name.includes('Microsoft') && (name.includes('Remote Display') || name.includes('Basic Display') || name.includes('Basic Render'))) return false;
    if (pnp.startsWith('SWD')) return false;
    if (status && !['ok', 'working properly', ''].includes(status.toLowerCase())) return false;
    return true;
  }

  function _is_software_gpu(gpu) {
    const name = gpu.Name || '';
    const status = gpu.Status || '';
    if (name.includes('Microsoft')) {
        if (name.includes('Remote Display')) return false;
        if (name.includes('Basic Display') || name.includes('Basic Render')) {
              if (!status || ['ok', 'working properly', ''].includes(status.toLowerCase())) return true;
        }
    }
    return false;
  }

  function _is_remote_display_gpu(gpu) {
    const name = gpu.Name || '';
    const status = gpu.Status || '';
    if (name.includes('Microsoft') && name.includes('Remote Display')) {
        if (!status || ['ok', 'working properly', ''].includes(status.toLowerCase())) return true;
    }
    return false;
  }

  function get_gpu_info() {
    let name = '';
    let driver_date = '';
    let driver_ver = '';
    let device_id = '';
    let vendor_id = '';

    if (os.platform() === 'win32') {
        try {
            const cmd = 'powershell -c "Get-CimInstance -query \'select * from win32_VideoController\' | Select-Object Name, @{N=\'DriverDate\';E={if($_.DriverDate){([datetime]$_.DriverDate).ToString(\'yyyy/MM/dd\')}}}, DriverVersion, PNPDeviceID, Status | ConvertTo-Json -Compress"';
            const output = execSync(cmd, { encoding: 'utf8' }).trim();

            if (output) {
                let gpus = [];
                try {
                    const parsed = JSON.parse(output);
                    gpus = Array.isArray(parsed) ? parsed : [parsed];
                } catch(e) {
                    // console.error('Failed to parse GPU info JSON', e);
                }

                let selectedGpu = null;

                // 1. Hardware
                for (const gpu of gpus) {
                    if (_is_hardware_gpu(gpu)) {
                        selectedGpu = gpu;
                        break;
                    }
                }

                // 2. Software
                if (!selectedGpu) {
                    for (const gpu of gpus) {
                        if (_is_software_gpu(gpu)) {
                            selectedGpu = gpu;
                            break;
                        }
                    }
                }

                // 3. Remote
                if (!selectedGpu) {
                    for (const gpu of gpus) {
                        if (_is_remote_display_gpu(gpu)) {
                            selectedGpu = gpu;
                            break;
                        }
                    }
                }

                if (selectedGpu) {
                    name = selectedGpu.Name || '';
                    driver_date = _format_driver_date(selectedGpu.DriverDate);
                    driver_ver = selectedGpu.DriverVersion || '';
                    const pnp = selectedGpu.PNPDeviceID || '';

                    if (pnp && !pnp.startsWith('SWD')) {
                        const devMatch = pnp.match(/DEV_(.{4})/);
                        const venMatch = pnp.match(/VEN_(.{4})/);
                        if (devMatch) device_id = devMatch[1];
                        if (venMatch) vendor_id = venMatch[1];
                    } else if (name.includes('Microsoft') && (name.includes('Basic Render') || name.includes('Basic Display') || name.includes('Remote Display'))) {
                          vendor_id = '1414';
                          if (name.includes('Basic Render')) device_id = '008c';
                          else if (name.includes('Basic Display')) device_id = '00ff';
                          else if (name.includes('Remote Display')) device_id = '008c';
                    }

                } else {
                      name = 'Microsoft Basic Render Driver';
                      vendor_id = '1414';
                      device_id = '008c';
                }
            }
        } catch (e) {
            console.error('Failed to get GPU info:', e.message);
        }
    }

    return { name, driver_date, driver_ver, device_id, vendor_id };
  }

  function get_cpu_info() {
    try {
        if (os.platform() === 'win32') {
             const cmd = 'powershell -c "Get-CimInstance -ClassName Win32_Processor | Select-Object -ExpandProperty Name"';
             const cpuName = execSync(cmd, { encoding: 'utf8' }).trim();
             return cpuName;
        } else {
             const cpus = os.cpus();
             if (cpus && cpus.length > 0) {
                 return cpus[0].model;
             }
        }
    } catch(e) {
        console.log('Failed to get CPU info:', e.message);
    }
    return 'Unknown CPU';
  }

  function get_npu_info() {
     let name = '';
     let driver_date = '';
     let driver_ver = '';
     try {
        if (os.platform() === 'win32') {
            // Try to find NPU devices from PnP entities.
            // Common potential names: "Intel(R) AI Boost", "LNP", "NPU"
            // We use Win32_PnPSignedDriver and sort by DriverDate descending to ensure we get the latest driver
            // if multiple matched entries exist (e.g. old versions or multiple components).
            const cmd = 'powershell -c "Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceName -match \'NPU|AI Boost|Hexagon|Movidius\' } | Sort-Object -Property DriverDate -Descending | Select-Object DeviceName, DriverVersion, @{N=\'DriverDate\';E={if($_.DriverDate){([datetime]$_.DriverDate).ToString(\'yyyy/MM/dd\')}}} | ConvertTo-Json -Compress"';
            const output = execSync(cmd, { encoding: 'utf8' }).trim();
            if (output) {
                let npu = null;
                try {
                    const parsed = JSON.parse(output);
                    // could be array (multiple devices/versions) or single object
                    // Since we sorted Descending, the first element (if array) is the latest.
                    npu = Array.isArray(parsed) ? parsed[0] : parsed;
                } catch(e) { /* ignore */ }

                if (npu) {
                    name = npu.DeviceName || 'Unknown NPU';
                    driver_ver = npu.DriverVersion || '';
                    driver_date = _format_driver_date(npu.DriverDate);
                }
            }
        }
     } catch(e) {
         console.log('Failed to get NPU info:', e.message);
     }
     if (!name) return 'Unknown NPU';
     return { name, driver_ver, driver_date };
  }

async function launchBrowser() {
    // Using flags found in current file + persistent context logic
    const args = [
       '--disable-gpu-watchdog',
       //'--disable-web-security',
       //'--ignore-certificate-errors',
       '--enable-features=WebMachineLearningNeuralNetwork',
       '--webnn-ort-ignore-ep-blocklist',
       '--ignore-gpu-blocklist',
       '--disable_webnn_for_npu=0',
       //'--webnn-ort-logging-level=VERBOSE',
   ];

   if (process.env.EXTRA_BROWSER_ARGS) {
       const extraArgs = process.env.EXTRA_BROWSER_ARGS.split(' ');
       extraArgs.forEach(arg => {
           if (arg.startsWith('--enable-features=')) {
               const matchIndex = args.findIndex(a => a.startsWith('--enable-features='));
               if (matchIndex !== -1) {
                   const newValue = arg.split('=')[1];
                   args[matchIndex] = `${args[matchIndex]},${newValue}`;
               } else {
                   args.push(arg);
               }
           } else if (arg.trim() !== '') {
               args.push(arg);
           }
       });
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
   } else {
        launchOptions.channel = 'chrome-canary'; // Default to chrome-canary
   }

   // We use a local persistent directory in the workspace.
   const userDataDir = path.join(__dirname, '..', 'user-data');
   if (!fs.existsSync(userDataDir)) {
       fs.mkdirSync(userDataDir, { recursive: true });
   }

   console.log(`[Launch] Launching Chrome from: ${userDataDir}`);

   let context, page, browser;

   // Use launchPersistentContext to reuse user data dir
   try {
       context = await chromium.launchPersistentContext(userDataDir, launchOptions);
       // Always create a new page for the test to avoid interference with restored tabs
       page = await context.newPage();
       await page.bringToFront();
   } catch (e) {
       console.error(`[Error] Failed to launch persistent context: ${e.message}`);
       console.log('[Warning]  Falling back to standard launch (fresh profile)...');
       browser = await chromium.launch(launchOptions);
       context = await browser.newContext();
       page = await context.newPage();
   }

   if (process.env.DEVICE) {
       const deviceType = process.env.DEVICE;
       await context.addInitScript((type) => {
           if (navigator.ml && !navigator.ml.createContext._instrumented) {
               const originalCreateContext = navigator.ml.createContext;
               navigator.ml.createContext = async function(options) {
                   options = options || {};
                   options.deviceType = type;
                   return originalCreateContext.call(navigator.ml, options);
               };
               navigator.ml.createContext._instrumented = true;
           }
       }, deviceType);
   }

   return { context, page, browser };
}

class WebNNRunner {
  constructor(page) {
    this.page = page;
    this.epFlag = process.env.EP_FLAG === 'true';
    this.launchNewBrowser = null;
  }

  // Ensure the page is available, recreating it if necessary
  async ensurePage() {
    if (this.page.isClosed()) {
      try {
        console.log('[Info] Page was closed, creating new page...');
        this.page = await this.page.context().newPage();
      } catch (e) {
        console.log('[Warning] Could not create new page from context, restarting browser...');
        const instance = await this.restartBrowserAndContext();
        this.page = instance.page;
      }
    }
  }

  // Wrapper for running a test with session failure monitoring
  async runTestWithSessionCheck(testFn, shouldRestart = true) {
    await this.ensurePage();
    const pageInUse = this.page;

    let sessionInitFailed = false;
    let sessionFailureMessage = '';

    const checkFailure = async (text) => {
      if (text.toLowerCase().includes('failed to create session')) {
        if (!sessionInitFailed) {
          sessionInitFailed = true;
          sessionFailureMessage = text;
          const msg = shouldRestart ? 'Restarting browser...' : 'Browser restart skipped (last case).';
          console.error(`[Fail] [Auto-Fail] "Failed to create session" detected. ${msg}`);
          try { await pageInUse.close(); } catch (e) {}
        }
      }
    };

    const failConsoleListener = async (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === 'error') {
        console.log(`[Browser Console] ${type}: ${text}`);
      }
      await checkFailure(text);
    };

    const failErrorListener = (err) => {
      const text = err.message || String(err);
      console.log(`[Browser Page Error] ${text}`);
      checkFailure(text);
    };

    pageInUse.on('console', failConsoleListener);
    pageInUse.on('pageerror', failErrorListener);

    try {
      await testFn();
      // Check if session failed even if testFn swallowed the error (e.g. via internal try/catch)
      if (sessionInitFailed) {
        throw new Error(`Failed to create session: ${sessionFailureMessage}`);
      }
    } catch (error) {
      if (sessionInitFailed) {
        console.log('[Info] Handling session failure recovery...');
        if (shouldRestart) {
          try {
              const currentContext = pageInUse.context();
              const objectToClose = currentContext.browser() || currentContext;
              const instance = await this.restartBrowserAndContext(objectToClose);
              this.page = instance.page;
          } catch (restartError) {
              console.error(`[Error] Failed to restart browser: ${restartError.message}`);
          }
        }
        throw new Error(`Failed to create session: ${sessionFailureMessage}`);
      }
      throw error;
    } finally {
      try {
        if (!pageInUse.isClosed()) {
            pageInUse.removeListener('console', failConsoleListener);
            pageInUse.removeListener('pageerror', failErrorListener);
        }
      } catch (e) {}
    }
  }

  // Helper function to check if two results are identical (works for both PASS and FAIL)
  compareTestResults(result1, result2) {
    if (!result1 || !result2) return false;
    if (result1.result !== result2.result) return false;

    // Compare subcase counts
    const sc1 = result1.subcases;
    const sc2 = result2.subcases;
    if (sc1.total !== sc2.total || sc1.passed !== sc2.passed || sc1.failed !== sc2.failed) {
      return false;
    }

    return true;
  }

  async restartBrowserAndContext(browserToClose) {
    if (browserToClose) {
      try {
        console.log('[Info] Closing browser before restart...');
        await browserToClose.close();
        console.log('[Success] Browser closed');
      } catch (e) {
        console.log(`[Warning] Error closing browser: ${e.message}`);
      }
    }

    // Force kill browser process to ensure clean restart (resolves "Failed to launch persistent context" issues)
    try {
        const channel = process.env.CHROME_CHANNEL || 'chrome';
        const processName = channel.includes('edge') ? 'msedge.exe' : 'chrome.exe';
        console.log(`[Info] Ensuring process ${processName} is terminated (taskkill)...`);
        execSync(`taskkill /F /IM ${processName}`, { stdio: 'ignore' });
    } catch (e) {
        // Process might not exist, which is fine
    }

    // Wait a bit to ensure process is fully gone
    await new Promise(resolve => setTimeout(resolve, 3000));

    if (!this.launchNewBrowser) {
      throw new Error('launchNewBrowser function is not defined');
    }

    console.log('[Info] Launching new browser...');
    const result = await this.launchNewBrowser();

    let newBrowser, newContext, newPage;

    // Handle both { browser } return type (Launch) and { context, page } return type (PersistentContext)
    if (result.context) {
        // Persistent Context case
        newBrowser = null; // No browser object exposed
        newContext = result.context;
        newPage = result.page;
        console.log('[Success] New persistent context launched');
    } else {
        // Standard Launch case
        newBrowser = result;
        console.log('[Success] New browser launched');
        console.log('[Info] Creating new context...');
        newContext = await newBrowser.newContext();
        console.log(`[Success] Created fresh browser context (ID: ${newContext._guid || 'N/A'})`);
        newPage = null; // Will be created by caller or here?
    }

    return { browser: newBrowser, context: newContext, page: newPage };
  }

  async checkOnnxruntimeDlls(processName = 'chrome.exe', retries = 3) {
    const MAX_RETRIES = retries;
    let attempt = 0;

    console.log(`[Info] Checking for ONNX Runtime DLLs in ${processName} (GPU Process)...`);

    while (attempt <= MAX_RETRIES) {
        try {
            // 1. Find GPU Process ID
            const cmdFind = `Get-WmiObject -Class Win32_Process -Filter "Name='${processName}'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
            // Increase maxBuffer just in case
            const stdout = execSync(cmdFind, { encoding: 'utf8', maxBuffer: 1024 * 1024, shell: 'powershell.exe' }).trim();

            if (!stdout) throw new Error(`Process ${processName} not found`);

            let processes = [];
            try {
                const parsed = JSON.parse(stdout);
                processes = Array.isArray(parsed) ? parsed : [parsed];
            } catch(e) {
                // Single object or parse error
            }

            const gpuProcess = processes.find(p => p.CommandLine && p.CommandLine.includes('--type=gpu-process'));

            if (!gpuProcess) {
                 // If no GPU process, maybe it hasn't started yet or running in single process mode?
                 // But for WebNN/WebGL usually there is one.
                 throw new Error('GPU process not found');
            }

            const pid = gpuProcess.ProcessId;

            // 2. Get Modules from that process
            // Usage of depth 2 is often enough for FileVersionInfo
            const cmdModules = `Get-Process -Id ${pid} | Select-Object -ExpandProperty Modules | Select-Object ModuleName, FileName, @{N='ProductVersion';E={$_.FileVersionInfo.ProductVersion}} | ConvertTo-Json -Compress`;

            const modulesJson = execSync(cmdModules, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 5, shell: 'powershell.exe' }).trim();

            if (!modulesJson) throw new Error('Failed to retrieve modules from GPU process');

            let modules = [];
            try {
                const parsed = JSON.parse(modulesJson);
                modules = Array.isArray(parsed) ? parsed : [parsed];
            } catch(e) { }

            // 3. Filter for ONNX Runtime related DLLs
            const findings = modules.filter(m => {
                const name = (m.ModuleName || '').toLowerCase();
                return name.includes('onnxruntime') || name.includes('openvino') || name.includes('directml');
            });

            if (findings.length > 0) {
                 const dllsOutput = findings.map(m => {
                     return `${m.FileName} (Version: ${m.ProductVersion || 'Unknown'})`;
                 }).join('\n');

                 console.log(`[Success] ONNX Runtime/Backend DLLs found:\n${dllsOutput}`);
                 return { found: true, dlls: dllsOutput, dllCount: findings.length };
            } else {
                 throw new Error('No ONNX Runtime/Backend DLLs found in GPU process modules');
            }

        } catch (e) {
            console.log(`[Warning] DLL Check Attempt ${attempt + 1} failed: ${e.message}`);

            if (attempt < MAX_RETRIES) {
                attempt++;
                await new Promise(r => setTimeout(r, 2000));
            } else {
                return { found: false, error: e.message };
            }
        }
    }
  }

  async checkOnnxruntimeDlls_ListDlls(processName = 'chrome.exe', retries = 3) {
    return new Promise((resolve) => {
      console.log(`[Info] Checking for ONNX Runtime DLLs in ${processName} process... (Attempts remaining: ${retries + 1})`);

      // Construct path to Listdlls64.exe in tools folder
      // We use __dirname to be relative to src/util.js, going up to root then tools
      const toolsPath = path.join(__dirname, '..', 'tools', 'Listdlls64.exe');

      // Run Listdlls64.exe -v <processName> and filter for onnxruntime*.dll files
      // Note: Using findstr on Windows with pattern matching for .dll files
      // Use quotes around executable path to handle spaces
      const command = `"${toolsPath}" -v ${processName} | findstr /i "onnxruntime.*\\.dll"`;

      console.log(`Running command: ${command}`);
      const { exec } = require('child_process');
      exec(command, { encoding: 'utf8', timeout: 60000 }, async (error, stdout, stderr) => {
        if (error) {
           console.log(`[Warning] Error/No output checking ONNX Runtime DLLs: ${error.message}`);

           if (retries > 0) {
               console.log(`[Info] Retrying DLL check...`);
               await new Promise(r => setTimeout(r, 2000));
               resolve(this.checkOnnxruntimeDlls(processName, retries - 1));
           } else {
               resolve({ found: false, error: error.message });
           }
           return;
        }

        const output = stdout;
        if (output && output.trim()) {
           // Verify that we actually found .dll files, not just any text containing "onnxruntime"
           // Filter out "Command line:" lines which Listdlls might print if they match the grep
           const dllLines = output.trim().split('\n')
               .filter(line => line.includes('.dll') && !line.trim().startsWith('Command line:'));

           if (dllLines.length > 0) {
               console.log(`[Success] ONNX Runtime DLL files found in ${processName} process:`);
               const cleanOutput = dllLines.join('\n');
               console.log(cleanOutput);
               resolve({ found: true, dlls: cleanOutput, dllCount: dllLines.length });
           } else {
               if (retries > 0) {
                   console.log(`[Info] No DLLs found in output, retrying...`);
                   await new Promise(r => setTimeout(r, 2000));
                   resolve(this.checkOnnxruntimeDlls(processName, retries - 1));
               } else {
                   resolve({ found: false, error: 'No onnxruntime DLLs found in output' });
               }
           }
        } else {
            console.log(`[Fail] No ONNX Runtime DLL files found in ${processName} process`);
            resolve({ found: false, dlls: '', reason: 'No output from command' });
        }
      });
    });
  }

  generateHtmlReport(testSuites, testCase, results, dllCheckResults = null, wallTime = null, sumOfTestTimes = null) {
    const totalSubcases = results.reduce((sum, r) => sum + r.subcases.total, 0);
    const passedSubcases = results.reduce((sum, r) => sum + r.subcases.passed, 0);
    const failedSubcases = results.reduce((sum, r) => sum + r.subcases.failed, 0);
    const passed = results.filter(r => r.result === 'PASS').length;
    const failed = results.filter(r => r.result === 'FAIL').length;
    const errors = results.filter(r => r.result === 'ERROR').length;

    // Use provided timing data or calculate from individual tests
    const displayWallTime = wallTime || results.reduce((sum, r) => sum + (parseFloat(r.executionTime) || 0), 0).toFixed(2);
    const displaySumOfTimes = sumOfTestTimes || results.reduce((sum, r) => sum + (parseFloat(r.executionTime) || 0), 0).toFixed(2);

    const suiteTitle = testSuites.length > 1 ?
      testSuites.map(s => s.toUpperCase()).join(', ') :
      testSuites[0].toUpperCase();

    // Device Info (CPU, GPU, NPU)
    let deviceInfoHtml = '';

    // CPU Info (if any test ran on cpu)
    const hasCpuTest = results.some(r => r.device === 'cpu');
    if (hasCpuTest) {
        const cpuName = get_cpu_info();
        deviceInfoHtml += `
        <div style="background-color: #e8f5e9; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #a5d6a7;">
            <h3 style="margin-top: 0; color: #2e7d32;">CPU Information</h3>
            <div style="display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: center;">
                <div style="font-weight: bold; color: #1b5e20;">CPU Name:</div>
                <div>${cpuName}</div>
            </div>
        </div>`;
    }

    // GPU Info (if any test ran on gpu)
    const hasGpuTest = results.some(r => r.device === 'gpu');
    if (hasGpuTest) {
        let gpuName = 'Unknown GPU';
        let gpuDriverDate = '';
        let gpuDriverVer = '';
        try {
            const info = get_gpu_info();
            if (info.name) {
                gpuName = info.name;
                gpuDriverDate = info.driver_date;
                gpuDriverVer = info.driver_ver;
            }
        } catch (e) {
            console.log('[Warning] Could not retrieve GPU info:', e.message);
        }

        deviceInfoHtml += `
        <div style="background-color: #e3f2fd; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #90caf9;">
            <h3 style="margin-top: 0; color: #0d47a1;">GPU Information</h3>
            <div style="display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: center;">
                <div style="font-weight: bold; color: #1565c0;">GPU Name:</div>
                <div>${gpuName}</div>
                <div style="font-weight: bold; color: #1565c0;">Driver Date:</div>
                <div>${gpuDriverDate}</div>
                <div style="font-weight: bold; color: #1565c0;">Driver Version:</div>
                <div>${gpuDriverVer}</div>
            </div>
        </div>`;
    }

    // NPU Info (if any test ran on npu)
    const hasNpuTest = results.some(r => r.device === 'npu');
    if (hasNpuTest) {
        let npuName = 'Unknown NPU';
        let npuDriverVer = '';
        let npuDriverDate = '';
        try {
             const info = get_npu_info();
             // get_npu_info returns object { name, driver_ver, driver_date } or string (old behavior backup)
             if (typeof info === 'string') {
                 if (info !== 'Unknown NPU') npuName = info;
             } else if (info && info.name) {
                 npuName = info.name;
                 npuDriverVer = info.driver_ver;
                 npuDriverDate = info.driver_date;
             }
        } catch(e) {
             console.log('[Warning] Could not retrieve NPU info:', e.message);
        }

        deviceInfoHtml += `
        <div style="background-color: #f3e5f5; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #ce93d8;">
            <h3 style="margin-top: 0; color: #7b1fa2;">NPU Information</h3>
             <div style="display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: center;">
                <div style="font-weight: bold; color: #4a148c;">NPU Name:</div>
                <div>${npuName}</div>
                ${npuDriverDate ? `<div style="font-weight: bold; color: #4a148c;">Driver Date:</div><div>${npuDriverDate}</div>` : ''}
                ${npuDriverVer ? `<div style="font-weight: bold; color: #4a148c;">Driver Version:</div><div>${npuDriverVer}</div>` : ''}
            </div>
        </div>`;
    }

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>WebNN Test Report - ${suiteTitle}</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 20px; }
        .header { background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
        .summary { margin-bottom: 20px; }
        .stat-card { background-color: white; border: 1px solid #e1e4e8; border-radius: 6px; padding: 15px; text-align: center; display: inline-block; margin: 5px; min-width: 150px; }
        .stat-number { font-size: 24px; font-weight: bold; margin-bottom: 5px; }
        .stat-label { color: #586069; font-size: 14px; }
        .pass { color: #28a745; } .fail { color: #dc3545; } .error { color: #fd7e14; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; }
        th { background-color: #f6f8fa; font-weight: 600; }
        .status-pass { color: #28a745; font-weight: bold; }
        .status-fail { color: #dc3545; font-weight: bold; }
        .status-error { color: #fd7e14; font-weight: bold; }
        .details { margin-top: 20px; }
        .case-details { margin: 15px 0; padding: 15px; border: 1px solid #e1e4e8; border-radius: 6px; }
        .subcase { margin: 5px 0; padding: 5px; background-color: #f8f9fa; border-radius: 3px; }
    </style>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 20px; background-color: #ffffff;">
    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #e1e4e8;">
        <h1 style="margin: 0; color: #24292e;">WebNN Test Report</h1>
    </div>

    ${deviceInfoHtml}

    <div style="margin-bottom: 20px;">
        <h3>Summary</h3>
        <table style="width: 100%; border-collapse: separate; border-spacing: 12px; margin-bottom: 20px;">
            <tr>
                <td style="text-align: center; padding: 20px; background-color: #ffffff; border: 1px solid #e1e4e8; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); width: 33%;">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: #24292e;">${results.length}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Total Cases</div>
                </td>
                <td style="text-align: center; padding: 20px; background-color: #ffffff; border: 1px solid #e1e4e8; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); width: 33%;">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: #24292e;">${totalSubcases}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Total Subcases</div>
                </td>
                <td style="text-align: center; padding: 20px; background-color: #ffffff; border: 1px solid #e1e4e8; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); width: 33%;">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: ${((passedSubcases/totalSubcases)*100) >= 100 ? '#28a745' : '#24292e'};">${Math.floor(((passedSubcases/totalSubcases)*100)*10)/10}%</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Success Rate</div>
                </td>
            </tr>
            <tr>
                <td style="text-align: center; padding: 20px; background-color: #f0fff4; border: 1px solid #c3e6cb; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: #28a745;">${passed}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Passed Cases</div>
                </td>
                <td style="text-align: center; padding: 20px; background-color: #f0fff4; border: 1px solid #c3e6cb; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: #28a745;">${passedSubcases}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Passed Subcases</div>
                </td>
                <td style="text-align: center; padding: 20px; background-color: #ffffff; border: 1px solid #e1e4e8; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: #586069;">${displayWallTime}s</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Wall Time</div>
                </td>
            </tr>
            <tr>
                <td style="text-align: center; padding: 20px; background-color: ${failed > 0 ? '#fff5f5' : '#ffffff'}; border: 1px solid ${failed > 0 ? '#f5c6cb' : '#e1e4e8'}; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: ${failed > 0 ? '#dc3545' : '#586069'};">${failed}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Failed Cases</div>
                </td>
                <td style="text-align: center; padding: 20px; background-color: ${failedSubcases > 0 ? '#fff5f5' : '#ffffff'}; border: 1px solid ${failedSubcases > 0 ? '#f5c6cb' : '#e1e4e8'}; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: ${failedSubcases > 0 ? '#dc3545' : '#586069'};">${failedSubcases}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Failed Subcases</div>
                </td>
                <td style="text-align: center; padding: 20px; background-color: #ffffff; border: 1px solid #e1e4e8; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: #586069;">${displaySumOfTimes}s</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Sum of Test Times</div>
                </td>
            </tr>
        </table>
    </div>

    <h3>Detailed Test Results</h3>
    ${(() => {
        const resultsByConfig = {};
        results.forEach(r => {
            const key = r.configName || 'Default';
            if (!resultsByConfig[key]) resultsByConfig[key] = [];
            resultsByConfig[key].push(r);
        });

        return Object.keys(resultsByConfig).map(configName => {
            const groupResults = resultsByConfig[configName];

            // Extract configuration info for display
            // Since a group might contain results from multiple split configs (e.g. diff devices),
            // we should collect unique values.
            const uniqueConfigValues = (key) => {
                const values = [...new Set(groupResults.map(r => r.fullConfig ? r.fullConfig[key] : null).filter(v => v !== null && v !== ''))];
                return values.length > 0 ? values.join(', ') : 'N/A';
            };

            const suiteStr = uniqueConfigValues('suite');
            const deviceStr = uniqueConfigValues('device');
            const argsStr = uniqueConfigValues('browserArgs');
            const wptCaseStr = uniqueConfigValues('wptCase');
            const modelCaseStr = uniqueConfigValues('modelCase');

            // Calculate Group Summary
            const groupTotal = groupResults.length;
            const groupPassed = groupResults.filter(r => r.result === 'PASS').length;
            const groupFailed = groupResults.filter(r => r.result === 'FAIL').length;
            const groupErrors = groupResults.filter(r => r.result === 'ERROR').length;
            const groupTotalSubcases = groupResults.reduce((s,r)=>s+r.subcases.total,0);
            const groupPassedSubcases = groupResults.reduce((s,r)=>s+r.subcases.passed,0);
            const groupFailedSubcases = groupResults.reduce((s,r)=>s+r.subcases.failed,0);
            const successRate = groupTotalSubcases > 0 ? ((groupPassedSubcases / groupTotalSubcases) * 100).toFixed(1) : '0.0';

            const groupSummaryHtml = `
            <div style="display: flex; gap: 15px; margin-bottom: 15px; font-size: 14px; background-color: #fff; padding: 12px; border: 1px solid #e1e4e8; border-radius: 6px; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
                 <div style="font-weight: bold; color: #24292e;">Cases: ${groupTotal}</div>
                 <div style="font-weight: bold; color: #28a745;">Pass: ${groupPassed}</div>
                 <div style="font-weight: bold; color: #dc3545;">Fail: ${groupFailed}</div>
                 ${groupErrors > 0 ? `<div style="font-weight: bold; color: #fd7e14;">Error: ${groupErrors}</div>` : ''}
                 <div style="width: 1px; background-color: #e1e4e8; margin: 0 5px;"></div>
                 <div style="font-weight: bold; color: #24292e;">Subcases: ${groupTotalSubcases}</div>
                 <div style="font-weight: bold; color: #28a745;">Pass: ${groupPassedSubcases}</div>
                 <div style="font-weight: bold; color: #dc3545;">Fail: ${groupFailedSubcases}</div>
                 <div style="width: 1px; background-color: #e1e4e8; margin: 0 5px;"></div>
                 <div style="font-weight: bold; color: ${successRate >= 100 ? '#28a745' : '#24292e'};">Success Rate: ${successRate}%</div>
            </div>`;

            let configDisplay = `
            <div style="background-color: #f1f8ff; border: 1px solid #c8e1ff; padding: 10px; border-radius: 6px; margin: 10px 0 20px 0; font-size: 14px;">
                <h4 style="margin: 0 0 10px 0; color: #0366d6;">Configuration Details: ${configName}</h4>
                <div style="display: grid; grid-template-columns: auto 1fr; gap: 8px;">
                    <div style="font-weight: bold; color: #24292e;">Suite:</div><div>${suiteStr.toUpperCase()}</div>
                    <div style="font-weight: bold; color: #24292e;">Device:</div><div>${deviceStr}</div>
                    ${argsStr !== 'N/A' ? `<div style="font-weight: bold; color: #24292e;">Browser Args:</div><div style="font-family: monospace; background-color: #fafbfc; padding: 2px 4px; border-radius: 3px;">${argsStr}</div>` : ''}
                    ${wptCaseStr !== 'N/A' ? `<div style="font-weight: bold; color: #24292e;">WPT Case:</div><div>${wptCaseStr}</div>` : ''}
                     ${modelCaseStr !== 'N/A' ? `<div style="font-weight: bold; color: #24292e;">Model Case:</div><div>${modelCaseStr}</div>` : ''}
                </div>
            </div>`;

            return `
            <h4>${configName}</h4>
            ${configDisplay}
            ${groupSummaryHtml}
            <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-family: sans-serif;">
                <thead>
                    <tr>
                        <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Device</th>
                        <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Suite</th>
                        <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Case</th>
                        <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Status</th>
                        <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Passed Subcases</th>
                        <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Failed Subcases</th>
                        <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Total Subcases</th>
                        <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Success Rate</th>
                        <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Retries</th>
                        <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Execution Time</th>
                    </tr>
                </thead>
                <tbody>
                    ${groupResults.map(result => {
                      const retryCount = result.retryHistory ? result.retryHistory.length - 1 : 0;
                      const retryInfo = retryCount > 0 ? `${retryCount} retry(ies)` : 'No retries';
                      const statusColor = result.result === 'PASS' ? '#28a745' : result.result === 'FAIL' ? '#dc3545' : '#fd7e14';
                      const statusStyle = `color: ${statusColor}; font-weight: bold;`;
                      const baseTdStyle = "border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left;";

                      return `
                        <tr>
                            <td style="${baseTdStyle}"><strong>${(result.device || 'N/A').toUpperCase()}</strong></td>
                            <td style="${baseTdStyle}"><strong>${(result.suite || 'N/A').toUpperCase()}</strong></td>
                            <td style="${baseTdStyle}">
                                <strong>${result.testName}</strong>
                                ${result.testUrl ? `<br><small><a href="${result.testUrl}" target="_blank" style="color: #0366d6;">${result.testUrl}</a></small>` : ''}
                                ${result.details && !result.details.includes('Exception') ? `<br><div style="margin-top:4px; font-size: 0.9em; color: #24292e; background-color: #e6ffed; padding: 5px; border-left: 3px solid #28a745; border-radius: 2px;">${result.details}</div>` : ''}
                                ${result.fullText && result.hasErrors ? `<br><div style="margin-top:4px; font-size: 0.9em; color: #a00; background-color: #fff0f0; padding: 5px; border-left: 3px solid #a00; border-radius: 2px;">${result.fullText}</div>` : ''}
                                ${result.retryHistory && result.retryHistory.length > 1 ? `
                                <br><details style="margin-top: 5px;">
                                    <summary style="cursor: pointer; color: #0366d6; font-size: 12px;">View Retry History (${retryCount} attempts)</summary>
                                    <div style="margin-top: 5px; padding: 10px; background-color: #f6f8fa; border-radius: 4px;">
                                        ${result.retryHistory.map((attempt, idx) => `
                                            <div style="margin: 3px 0; font-size: 11px;">
                                                <strong>${idx === 0 ? 'Initial Run' : 'Retry ' + idx}:</strong>
                                                <span style="color: ${attempt.status === 'PASS' ? '#28a745' : attempt.status === 'FAIL' ? '#dc3545' : '#fd7e14'}; font-weight: bold;">${attempt.status}</span>
                                                (${attempt.passed}/${attempt.total} passed, ${attempt.failed} failed)
                                            </div>
                                        `).join('')}
                                    </div>
                                </details>
                                ` : ''}
                            </td>
                            <td style="${baseTdStyle} ${statusStyle}">${result.result}</td>
                            <td style="${baseTdStyle} color: #28a745;"><strong>${result.subcases.passed}</strong></td>
                            <td style="${baseTdStyle} color: #dc3545;"><strong>${result.subcases.failed}</strong></td>
                            <td style="${baseTdStyle}"><strong>${result.subcases.total}</strong></td>
                            <td style="${baseTdStyle}"><strong>${result.subcases.total > 0 ? ((result.subcases.passed/result.subcases.total)*100).toFixed(1) : 0}%</strong></td>
                            <td style="${baseTdStyle} font-size: 12px; color: #586069;">${retryInfo}</td>
                            <td style="${baseTdStyle}"><strong>${result.executionTime ? result.executionTime + 's' : 'N/A'}</strong></td>
                        </tr>
                      `;
                    }).join('')}
                    <tr style="background-color: #e8f5e9; font-weight: bold;">
                        <td colspan="4" style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left;"><strong>TOTAL (${configName})</strong></td>
                        <td style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; color: #28a745;"><strong>${groupResults.reduce((s,r)=>s+r.subcases.passed,0)}</strong></td>
                        <td style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; color: #dc3545;"><strong>${groupResults.reduce((s,r)=>s+r.subcases.failed,0)}</strong></td>
                        <td style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left;"><strong>${groupResults.reduce((s,r)=>s+r.subcases.total,0)}</strong></td>
                        <td colspan="3" style="border: 1px solid #e1e4e8; padding: 8px 12px;"></td>
                    </tr>
                </tbody>
            </table>
            `;
        }).join('');
    })()}

    ${results.filter(r => r.retryHistory && r.retryHistory.length > 1).length > 0 ? `
    <h3>Retry Analysis</h3>
    <div style="background-color: #fff3cd; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
        <p><strong>${results.filter(r => r.retryHistory && r.retryHistory.length > 1).length}</strong> test(s) required retries</p>
    </div>
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-family: sans-serif;">
        <thead>
            <tr>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Test Case</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Initial Status</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Final Status</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Retry Attempts</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Subcase Changes</th>
            </tr>
        </thead>
        <tbody>
            ${results.filter(r => r.retryHistory && r.retryHistory.length > 1).map(result => {
              const initial = result.retryHistory[0];
              const final = result.retryHistory[result.retryHistory.length - 1];
              const retryCount = result.retryHistory.length - 1;
              const subcaseChange = final.passed !== initial.passed || final.failed !== initial.failed;

              const baseTdStyle = "border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left;";
              const getStatusColor = (status) => status === 'PASS' ? '#28a745' : status === 'FAIL' ? '#dc3545' : '#fd7e14';

              return `
                <tr>
                    <td style="${baseTdStyle}"><strong>${result.testName}</strong></td>
                    <td style="${baseTdStyle} font-weight: bold; color: ${getStatusColor(initial.status)};">${initial.status}<br><small style="font-weight: normal; color: #586069;">(${initial.passed}/${initial.total} passed)</small></td>
                    <td style="${baseTdStyle} font-weight: bold; color: ${getStatusColor(final.status)};">${final.status}<br><small style="font-weight: normal; color: #586069;">(${final.passed}/${final.total} passed)</small></td>
                    <td style="${baseTdStyle}">${retryCount}</td>
                    <td style="${baseTdStyle}">
                        ${subcaseChange ?
                          `<span style="color: #fd7e14;">[Changed]</span><br>
                           <small>Passed: ${initial.passed} -> ${final.passed}<br>
                           Failed: ${initial.failed} -> ${final.failed}</small>` :
                          '<span style="color: #28a745;">[Consistent]</span>'}
                    </td>
                </tr>
                <tr>
                    <td colspan="5" style="padding: 0; border: 1px solid #e1e4e8;">
                        <details style="padding: 10px; background-color: #f6f8fa;">
                            <summary style="cursor: pointer; font-weight: bold;">View All Attempts</summary>
                            <div style="margin-top: 10px;">
                                ${result.retryHistory.map((attempt, idx) => `
                                    <div style="padding: 8px; margin: 5px 0; background-color: white; border-left: 3px solid ${getStatusColor(attempt.status)}; border-radius: 3px;">
                                        <strong>${idx === 0 ? 'Initial Run' : 'Retry Attempt ' + idx}:</strong>
                                        <span style="font-weight: bold; color: ${getStatusColor(attempt.status)};">${attempt.status}</span><br>
                                        <small>Passed: ${attempt.passed} | Failed: ${attempt.failed} | Total: ${attempt.total}</small>
                                    </div>
                                `).join('')}
                            </div>
                        </details>
                    </td>
                </tr>
              `;
            }).join('')}
        </tbody>
    </table>
    ` : ''}

    ${dllCheckResults && dllCheckResults.found ? `
    <h3>ONNX Runtime DLL Detection</h3>
    <div style="margin: 15px 0; padding: 15px; border: 1px solid #e1e4e8; border-radius: 6px; background-color: #e3f2fd;">
        <h4 style="margin-top: 0;">ONNX Runtime DLLs Found (${dllCheckResults.dllCount} DLL files)</h4>
        <p><strong>Detection Time:</strong> ${new Date().toLocaleString()}</p>
        <pre style="background-color: #f8f9fa; padding: 15px; border-radius: 6px; overflow-x: auto; font-family: monospace;">${dllCheckResults.dlls}</pre>
    </div>
    ` : dllCheckResults && !dllCheckResults.found ? `
    <h3>ONNX Runtime DLL Detection</h3>
    <div style="margin: 15px 0; padding: 15px; border: 1px solid #e1e4e8; border-radius: 6px; background-color: #fff3cd;">
        <h4 style="margin-top: 0;">No ONNX Runtime DLLs Found</h4>
        <p><strong>Reason:</strong> ${dllCheckResults.reason || dllCheckResults.error || 'Unknown'}</p>
    </div>
    ` : ''}

</body>
</html>`;
  }

  generateSubcaseTable(testSuites, results) {
    const totalSubcases = results.reduce((sum, r) => sum + r.subcases.total, 0);
    const passedSubcases = results.reduce((sum, r) => sum + r.subcases.passed, 0);
    const failedSubcases = results.reduce((sum, r) => sum + r.subcases.failed, 0);

    const suiteTitle = testSuites.length > 1 ?
      testSuites.map(s => s.toUpperCase()).join(', ') :
      testSuites[0].toUpperCase();

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Subcase Summary - ${suiteTitle}</title>
    <style>
        body { font-family: monospace; background: #f8f9fa; padding: 20px; }
        table { background: white; border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #ccc; padding: 8px 12px; text-align: left; }
        th { background: #e9ecef; font-weight: bold; }
        .summary-row { background: #d4edda; font-weight: bold; }
        .pass { color: #28a745; } .fail { color: #dc3545; } .error { color: #fd7e14; }
    </style>
</head>
<body>
    <h2>Subcases Summary Table - ${suiteTitle}</h2>
    <table>
        <thead>
            <tr>
                <th>Case Name</th>
                <th>Total Subcases</th>
                <th>Passed Subcases</th>
                <th>Failed Subcases</th>
                <th>Status</th>
            </tr>
        </thead>
        <tbody>
            ${results.map(result => `
                <tr>
                    <td>${result.testName}</td>
                    <td>${result.subcases.total}</td>
                    <td class="pass">${result.subcases.passed}</td>
                    <td class="fail">${result.subcases.failed}</td>
                    <td class="${result.result.toLowerCase()}">${result.result === 'PASS' ? 'PASS' : result.result === 'FAIL' ? 'FAIL' : 'ERROR'}</td>
                </tr>, launchBrowser
            `).join('')}
            <tr class="summary-row">
                <td><strong>TOTAL (${suiteTitle})</strong></td>
                <td><strong>${totalSubcases}</strong></td>
                <td class="pass"><strong>${passedSubcases}</strong></td>
                <td class="fail"><strong>${failedSubcases}</strong></td>
                <td><strong>${results.filter(r => r.result === 'PASS').length}/${results.length} cases</strong></td>
            </tr>
        </tbody>
    </table>
</body>
</html>`;
  }

  async sendEmailReport(emailAddress, testSuites, results, wallTime, sumOfTestTimes, reportTimestamp = null, htmlReportContent = null) {
    try {
      console.log(`\n[Info] Sending email report to ${emailAddress}...`);

      // Calculate summary statistics
      const totalSubcases = results.reduce((sum, r) => sum + r.subcases.total, 0);
      const passedSubcases = results.reduce((sum, r) => sum + r.subcases.passed, 0);
      const successRate = totalSubcases > 0 ? ((passedSubcases / totalSubcases) * 100).toFixed(1) : '0.0';

      const suiteTitle = testSuites.length > 1 ?
        testSuites.map(s => s.toUpperCase()).join(', ') :
        testSuites[0].toUpperCase();

      // Get machine name
      const os = require('os');
      const machineName = os.hostname();

      // GPU info is no longer needed in the subject, only in the report body if applicable

      // Use provided timestamp (from report filename) or generate new one
      const timestamp = reportTimestamp || (() => {
        const now = new Date();
        return now.getFullYear().toString() +
               (now.getMonth() + 1).toString().padStart(2, '0') +
               now.getDate().toString().padStart(2, '0') +
               now.getHours().toString().padStart(2, '0') +
               now.getMinutes().toString().padStart(2, '0') +
               now.getSeconds().toString().padStart(2, '0');
      })();

      // Create email subject: [WebNN Test Report] timestamp | machine name
      const subject = `[WebNN Test Report] ${timestamp} | ${machineName}`;

      // Use provided HTML content or generate new one
      const htmlBody = htmlReportContent || this.generateHtmlReport(testSuites, null, results, null, wallTime, sumOfTestTimes);

      await send_email(subject, htmlBody, '', emailAddress);

      console.log(`[Success] Email sent successfully to ${emailAddress}`);
    } catch (error) {
      console.error(`[Fail] Failed to send email: ${error.message}`);
      console.error(`   This is a non-critical error - test results are still available in the HTML report`);
    }
  }
}

module.exports = { WebNNRunner, launchBrowser };
