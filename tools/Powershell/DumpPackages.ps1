param(
    [Parameter(Mandatory = $true, HelpMessage = "Specify the search term to filter AppX packages by family name")]
    [string]$SearchTerm,
    
    [Parameter(Mandatory = $false, HelpMessage = "Include package dependencies in the output")]
    [switch]$dumpDependencies
)

# Retrieve all AppX packages (for all users) where the family name includes the search term
$filteredPackages = Get-AppxPackage -AllUsers |
    Where-Object { $_.PackageFamilyName -like "*$SearchTerm*" }

# Output the results
if ($filteredPackages) {
    Write-Host "Found AppX packages with '$SearchTerm' in the family name:" -ForegroundColor Cyan
    Write-Host ""
    
    foreach ($package in $filteredPackages) {
        Write-Host "Package Name: $($package.Name)" -ForegroundColor Green
        Write-Host "Family Name:  $($package.PackageFamilyName)" -ForegroundColor White
        Write-Host "Full Name:    $($package.PackageFullName)" -ForegroundColor White
        Write-Host "Version:      $($package.Version)" -ForegroundColor White
        Write-Host "Install Path: $($package.InstallLocation)" -ForegroundColor White
        
        if ($package -and $package.Dependencies) {
            Write-Host "Dependencies:" -ForegroundColor Yellow
            foreach ($dependency in $package.Dependencies) {
                Write-Host "  - $($dependency.Name) ($($dependency.Version))" -ForegroundColor Gray
            }
        }
        
        Write-Host ("-" * 80) -ForegroundColor DarkGray
    }
} else {
    Write-Host "No AppX packages found with '$SearchTerm' in the family name." -ForegroundColor Yellow
}