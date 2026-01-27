# Copyright (c) Microsoft Corporation and Contributors.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Finds and displays all available Windows Machine Learning execution providers.

.DESCRIPTION
    This script demonstrates how to use the Windows App SDK Dynamic Dependency API
    from PowerShell to access Windows Machine Learning execution providers.

    The script performs the following operations:
    1. Creates a Process lifetime package dependency on Windows App Runtime 1.8
    2. Adds the package dependency to the current process
    3. Instantiates the ExecutionProviderCatalog from the ML APIs
    4. Finds all available execution providers in the catalog
    5. Calls EnsureReadyAsync() on each provider and waits for completion
    6. Displays detailed information including:
       - Provider name and ready state
       - Package information (name, version, architecture, publisher, family name)
       - Library path to the execution provider DLL
       - Certification status

    This demonstrates proper usage of WinRT async operations from PowerShell using
    reflection to access the AsTask() extension method for synchronous waiting.
#>

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

try {
    Write-Host "Creating package dependency on Windows App Runtime 1.8..."

    # Windows App Runtime package family name
    $packageFamilyName = "Microsoft.WindowsAppRuntime.1.8_8wekyb3d8bbwe"

    # Minimum version for Windows App Runtime 1.8 (version 8000.0.0.0)
    $minVersion = 8000L -shl 48

    # Create the package dependency with Process lifetime
    $packageDependencyId = & "$PSScriptRoot\TryCreate-PackageDependency.ps1" `
        -PackageFamilyName $packageFamilyName `
        -MinVersion $minVersion `
        -LifetimeKind Process

    Write-Host "Package dependency created: $packageDependencyId"

    # Add the package dependency to the current process
    Write-Host "Adding package dependency to process..."
    $result = & "$PSScriptRoot\Add-PackageDependency.ps1" `
        -PackageDependencyId $packageDependencyId `
        -Rank 0

    Write-Host "Package dependency added successfully"
    Write-Host "Package Full Name: $($result.PackageFullName)"
    Write-Host "Package Dependency Context: $($result.PackageDependencyContext)"

    # Instantiate ExecutionProviderCatalog
    Write-Host "`nInstantiating ExecutionProviderCatalog..."
    $catalog = [Microsoft.Windows.AI.MachineLearning.ExecutionProviderCatalog, Microsoft.Windows.AI.MachineLearning, ContentType=WindowsRuntime]::GetDefault()
    Write-Host "ExecutionProviderCatalog instantiated successfully!"

    # Load System.Runtime.WindowsRuntime for AsTask extension method
    $wrAssembly = [System.Reflection.Assembly]::Load("System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089")

    # Display available execution providers
    Write-Host "`nAvailable Execution Providers:"
    $providers = $catalog.FindAllProviders()

    if ($providers -eq $null -or $providers.Count -eq 0) {
        Write-Host "  No execution providers found in catalog."
    }

    foreach ($provider in $providers) {
        Write-Host "  - Name: $($provider.Name)"
        Write-Host "    Initial Ready State: $($provider.ReadyState)"

        # Ensure the provider is ready
        Write-Host "    Ensuring provider is ready..."
        try {
            $asyncOp = $provider.EnsureReadyAsync()

            # Get the AsTask extension method for IAsyncOperationWithProgress<TResult, TProgress>
            $asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
                Where-Object {
                    $_.Name -eq "AsTask" -and
                    $_.IsGenericMethodDefinition -and
                    $_.GetGenericArguments().Length -eq 2 -and
                    $_.GetParameters().Length -eq 1 -and
                    $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperationWithProgress``2"
                } | Select-Object -First 1

            # Make it generic with ExecutionProviderReadyResult and double (progress)
            $genericMethod = $asTaskMethod.MakeGenericMethod(
                [Microsoft.Windows.AI.MachineLearning.ExecutionProviderReadyResult],
                [double]
            )

            # Call it and wait for result
            $task = $genericMethod.Invoke($null, @($asyncOp))
            $readyResult = $task.Result

            if ($readyResult -ne $null) {
                Write-Host "    Ready Result Status: $($readyResult.Status)"

                if ($readyResult.ExtendedError -ne $null) {
                    Write-Host "    Error HRESULT: 0x$($readyResult.ExtendedError.HResult.ToString('X8'))"
                    Write-Host "    Error Message: $($readyResult.ExtendedError.Message)"
                }

                if (![string]::IsNullOrEmpty($readyResult.DiagnosticText)) {
                    Write-Host "    Diagnostic Text: $($readyResult.DiagnosticText)"
                }
            }
        }
        catch {
            Write-Host "    Exception during EnsureReadyAsync: $_"
        }

        Write-Host "    Final Ready State: $($provider.ReadyState)"
        Write-Host "    Certification: $($provider.Certification)"

        # Display PackageId if available
        if ($provider.PackageId -ne $null -and ![string]::IsNullOrEmpty($provider.PackageId.Name)) {
            Write-Host "    Package ID:"
            Write-Host "      Name: $($provider.PackageId.Name)"
            Write-Host "      Version: $($provider.PackageId.Version.Major).$($provider.PackageId.Version.Minor).$($provider.PackageId.Version.Build).$($provider.PackageId.Version.Revision)"
            Write-Host "      Architecture: $($provider.PackageId.Architecture)"
            Write-Host "      Publisher: $($provider.PackageId.Publisher)"
            Write-Host "      Family Name: $($provider.PackageId.FamilyName)"
            Write-Host "      Full Name: $($provider.PackageId.FullName)"
        } else {
            Write-Host "    Package: Not installed"
        }

        # Display Library Path
        if (![string]::IsNullOrEmpty($provider.LibraryPath)) {
            Write-Host "    Library Path: $($provider.LibraryPath)"
        } else {
            Write-Host "    Library Path: Not available (provider not ready)"
        }

        Write-Host ""
    }

    Write-Host "Script completed successfully!"
}
catch {
    Write-Error "An error occurred: $_"
    Write-Error $_.ScriptStackTrace
    exit 1
}
