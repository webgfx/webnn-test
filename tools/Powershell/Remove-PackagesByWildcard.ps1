#Requires -RunAsAdministrator

<#
.SYNOPSIS
    Removes packages for all users based on a wildcard pattern.

.DESCRIPTION
    This script searches for and removes packages that match a specified wildcard pattern
    for all users on the system. It requires administrator privileges to run.

.PARAMETER SearchPattern
    The wildcard pattern to search for packages. Supports wildcards like * and ?.
    Example: "Microsoft.Xbox*" or "*Game*"

.PARAMETER WhatIf
    Shows what packages would be removed without actually removing them.

.PARAMETER Confirm
    Prompts for confirmation before removing each package.

.EXAMPLE
    .\Remove-PackagesByWildcard.ps1 -SearchPattern "Microsoft.Xbox*"
    Removes all Xbox-related Microsoft packages for all users.

.EXAMPLE
    .\Remove-PackagesByWildcard.ps1 -SearchPattern "*Candy*" -WhatIf
    Shows what Candy-related packages would be removed without actually removing them.

.NOTES
    - Requires PowerShell 5.0 or later
    - Must be run as Administrator
    - Uses Get-AppxPackage and Remove-AppxPackage cmdlets
#>

param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$SearchPattern,
    
    [Parameter(Mandatory=$false)]
    [switch]$WhatIf,
    
    [Parameter(Mandatory=$false)]
    [switch]$Confirm
)

# Check if running as administrator
if (-NOT ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Error "This script must be run as Administrator. Please run PowerShell as Administrator and try again."
    exit 1
}

Write-Host "Searching for packages matching pattern: $SearchPattern" -ForegroundColor Yellow

try {
    # Get all packages for all users matching the pattern
    $packages = Get-AppxPackage -AllUsers | Where-Object { $_.Name -like $SearchPattern }
    
    if (-not $packages -or $packages.Count -eq 0) {
        Write-Host "No packages found matching pattern: $SearchPattern" -ForegroundColor Green
        exit 0
    }
    
    $packageCount = @($packages).Count
    Write-Host "Found $packageCount package(s) matching the pattern:" -ForegroundColor Cyan
    
    foreach ($package in $packages) {
        $packageInfo = "Package: " + $package.Name + " | Version: " + $package.Version + " | Architecture: " + $package.Architecture
        Write-Host "  - $packageInfo" -ForegroundColor White
    }
    
    Write-Host ""
    
    if ($WhatIf) {
        Write-Host "WhatIf mode: The above packages would be removed, but no action was taken." -ForegroundColor Green
        exit 0
    }
    
    # Confirm removal if -Confirm switch is used or if more than 5 packages
    if ($Confirm -or $packageCount -gt 5) {
        $confirmation = Read-Host "Are you sure you want to remove all $packageCount package(s)? (Y/N)"
        if ($confirmation -notmatch '^[Yy]([Ee][Ss])?$') {
            Write-Host "Operation cancelled by user." -ForegroundColor Yellow
            exit 0
        }
    }
    
    Write-Host "Removing packages..." -ForegroundColor Red
    
    $successCount = 0
    $errorCount = 0
    
    foreach ($package in $packages) {
        try {
            Write-Host ("Removing: " + $package.Name) -ForegroundColor Yellow
            Remove-AppxPackage -Package $package.PackageFullName -AllUsers -ErrorAction Continue
            Write-Host ("  + Successfully removed: " + $package.Name) -ForegroundColor Green
            $successCount++
        }
        catch {
            Write-Warning ("  X Failed to remove: " + $package.Name + " - Error: " + $_.Exception.Message)
            $errorCount++
        }
    }
    
    Write-Host ""
    Write-Host "Removal Summary:" -ForegroundColor Cyan
    Write-Host "  Successfully removed: $successCount packages" -ForegroundColor Green
    if ($errorCount -gt 0) {
        Write-Host "  Failed to remove: $errorCount packages" -ForegroundColor Red
    }
}
catch {
    Write-Error ("An error occurred while searching for packages: " + $_.Exception.Message)
    exit 1
}

Write-Host "Script completed." -ForegroundColor Green