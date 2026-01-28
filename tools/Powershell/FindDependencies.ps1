param (
    [Parameter(Mandatory = $true)]
    [string]$TargetPackageName
)

$allPackages = Get-AppxPackage

$dependentApps = @()

foreach ($pkg in $allPackages) {
    if ($pkg.Dependencies -contains $TargetPackageName) {
        $dependentApps += [PSCustomObject]@{
            AppName         = $pkg.Name
            PackageFullName = $pkg.PackageFullName
            Publisher       = $pkg.Publisher
        }
    }
}

if ($dependentApps.Count -eq 0) {
    Write-Output "No applications found that depend on package '$TargetPackageName'."
} else {
    Write-Output "Applications that depend on package '$TargetPackageName':"
    $dependentApps | Format-Table -AutoSize
}