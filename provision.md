* Install WinAppRuntime
https://learn.microsoft.com/en-us/windows/apps/windows-app-sdk/downloads
Install as an Administrator

* Install EPs
ExecutionProviderCatalog.exe

WindowsAppSDK\dev\DynamicDependency\Powershell
EnsureWinMLExecutionProviders.ps1

* Check
DumpPackages.ps1 and search for WindowsAppRuntime

* Check EP
Listdlls64.exe -v chrome.exe | findstr /i "onnxruntime.*.dll"

* Delete
\\edgefs\users\rcintron\scripts\Remove-PackagesByWildcard.ps1
Remove-AppxPackage -Package '<package_full_name>'


* Resources
https://webai.run/tests
https://microsoft.github.io/webnn-developer-preview/
https://webmachinelearning.github.io/webnn-samples-intro/
https://huggingface.co/webnn/spaces

https://source.chromium.org/chromium/chromium/src/+/main:services/webnn/public/cpp/win_app_runtime_package_info.h
https://source.chromium.org/chromium/chromium/src/+/main:services/webnn/public/cpp/execution_providers_info.h

https://webnn.io/en/api-reference/browser-compatibility/chrome-flags

https://github.com/webmachinelearning/webnn-samples-test-framework