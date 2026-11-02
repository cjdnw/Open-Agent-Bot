# Idempotent upsert: daily 20:00 local (machine timezone should be Asia/Shanghai / UTC+8)
# TaskName is ASCII-safe; Chinese label lives in Description (avoids PS5.1 script encoding corruption).
$ErrorActionPreference = "Stop"
$ReportDir = Join-Path $env:USERPROFILE ".openmausbot\quota-report"
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
$Node = if ($NodeCmd) { $NodeCmd.Source } else { Join-Path $env:USERPROFILE ".local\nodejs\node.exe" }
if (-not (Test-Path -LiteralPath $Node)) { throw "node.exe not found" }
$Runner = Join-Path $ReportDir "run-daily.mjs"
if (-not (Test-Path -LiteralPath $Runner)) { throw "missing $Runner" }

$TaskName = "XinyunOpen-QuotaDailyReport"
$DisplayZh = [string]::new([char[]]@(0x6BCF,0x65E5,0x20,0x41,0x49,0x20,0x6A21,0x578B,0x989D,0x5EA6,0x6C47,0x62A5))
$Arg = '"' + $Runner + '"'
$Action = New-ScheduledTaskAction -Execute $Node -Argument $Arg -WorkingDirectory $ReportDir
$Trigger = New-ScheduledTaskTrigger -Daily -At 20:00
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$Description = "$DisplayZh | XinyunOpen Bot daily AI quota snapshot (20:00 Asia/Shanghai)"

# Remove any prior quota collectors that run the same runner (including mojibake names)
Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
  $args = ($_.Actions | ForEach-Object { $_.Arguments }) -join ' '
  $args -match 'quota-report\\run-daily\.mjs' -or $_.TaskName -eq $TaskName
} | ForEach-Object {
  Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false -ErrorAction SilentlyContinue
}

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Description $Description | Out-Null

$matches = @(Get-ScheduledTask | Where-Object {
  (($_.Actions | ForEach-Object { $_.Arguments }) -join ' ') -match 'quota-report\\run-daily\.mjs'
})
if ($matches.Count -ne 1) {
  throw "expected exactly one quota-report task, found $($matches.Count)"
}
if ($matches[0].TaskName -ne $TaskName) {
  throw "unexpected task name $($matches[0].TaskName)"
}

schtasks /Query /TN $TaskName /FO LIST | Out-Host
Write-Output ("INSTALLED " + $TaskName)
Write-Output ("DISPLAY " + $DisplayZh)
Write-Output ("NODE " + $Node)
Write-Output ("RUNNER " + $Runner)
Write-Output ("LOGDIR " + (Join-Path $ReportDir "logs"))
