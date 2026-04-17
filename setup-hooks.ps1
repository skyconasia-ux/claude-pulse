# LiveVisualUsage — Hook Setup Script
# Merges the required hooks into ~/.claude/settings.json without overwriting existing config.

$settingsPath = "$env:USERPROFILE\.claude\settings.json"
$hookCmd = 'powershell -NoProfile -Command "$body = $input | Out-String; if ($body.Trim()) { try { Invoke-RestMethod -Uri ''http://localhost:3001/hook'' -Method Post -Body $body -ContentType ''application/json'' | Out-Null } catch {} }"'

$hookEntry = @{ type = "command"; command = $hookCmd }

Write-Host ""
Write-Host "  LiveVisualUsage Hook Setup" -ForegroundColor Cyan
Write-Host "  ==========================" -ForegroundColor Cyan
Write-Host ""

# Load or create settings
if (Test-Path $settingsPath) {
    $raw = Get-Content $settingsPath -Raw
    $settings = $raw | ConvertFrom-Json
    Write-Host "  Found existing settings: $settingsPath" -ForegroundColor Green
} else {
    $settings = [PSCustomObject]@{}
    $dir = Split-Path $settingsPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Write-Host "  Creating new settings: $settingsPath" -ForegroundColor Yellow
}

# Ensure hooks property exists
if (-not ($settings.PSObject.Properties.Name -contains "hooks")) {
    $settings | Add-Member -MemberType NoteProperty -Name "hooks" -Value ([PSCustomObject]@{})
}

# Helper: upsert a hook array for an event, skip if already present
function Set-Hook($eventName, $matcher) {
    $hooks = $settings.hooks
    $entry = if ($matcher) {
        [PSCustomObject]@{ matcher = $matcher; hooks = @($hookEntry) }
    } else {
        [PSCustomObject]@{ hooks = @($hookEntry) }
    }

    if ($hooks.PSObject.Properties.Name -contains $eventName) {
        $existing = $hooks.$eventName
        $alreadySet = $existing | Where-Object { $_.hooks | Where-Object { $_.command -eq $hookCmd } }
        if ($alreadySet) {
            Write-Host "  $eventName hook already configured — skipped" -ForegroundColor Gray
            return
        }
        $hooks.$eventName = @($existing) + $entry
    } else {
        $hooks | Add-Member -MemberType NoteProperty -Name $eventName -Value @($entry)
    }
    Write-Host "  $eventName hook added" -ForegroundColor Green
}

Set-Hook "PostToolUse" "*"
Set-Hook "Stop" $null
Set-Hook "Notification" $null

# Write back
$settings | ConvertTo-Json -Depth 10 | Set-Content $settingsPath -Encoding UTF8

Write-Host ""
Write-Host "  Done. Restart Claude Code for hooks to take effect." -ForegroundColor Cyan
Write-Host ""
