#Requires -RunAsAdministrator

param(
    [Parameter(Mandatory=$true)]
    [string]$FrameworkFamilyName
)

Write-Host "Searching for packages dependent on: $FrameworkFamilyName" -ForegroundColor Yellow
Write-Host ""

# Get all installed packages
$allPackages = Get-AppxPackage -AllUsers

$foundCount = 0

# Check each package for dependencies
foreach ($package in $allPackages) {
    if ($package.Dependencies) {
        foreach ($dependency in $package.Dependencies) {
            if ($dependency.PackageFamilyName -like "*$FrameworkFamilyName*") {
                $foundCount++
                Write-Host "----------------------------------------" -ForegroundColor Cyan
                Write-Host "Package Name:        " -NoNewline; Write-Host $package.Name -ForegroundColor White
                Write-Host "Family Name:         " -NoNewline; Write-Host $package.PackageFamilyName -ForegroundColor White
                Write-Host "Full Name:           " -NoNewline; Write-Host $package.PackageFullName -ForegroundColor White
                Write-Host "Version:             " -NoNewline; Write-Host $package.Version -ForegroundColor White
                Write-Host "Installation Path:   " -NoNewline; Write-Host $package.InstallLocation -ForegroundColor White
                break
            }
        }
    }
}

# Display summary
Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host ""
if ($foundCount -eq 0) {
    Write-Host "No packages found that depend on $FrameworkFamilyName" -ForegroundColor Red
}
else {
    Write-Host "Total: Found $foundCount dependent package(s)" -ForegroundColor Green
}