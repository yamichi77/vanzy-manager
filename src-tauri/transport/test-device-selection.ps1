# Offline tests: execute only pure name/selection helpers, never BLE worker bodies.
$ErrorActionPreference='Stop'
foreach($worker in @('vanzy-windows.ps1','vanzy-host.ps1')) {
 $tokens=$null; $errors=$null
 $ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $worker),[ref]$tokens,[ref]$errors)
 if($errors.Count){throw ($errors | Out-String)}
 foreach($name in @('Test-VanzyProductName','Get-SingleVanzyTarget')) {
  $fn=@($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$false) | Where-Object {$_.Name -ceq $name})
  if($fn.Count -ne 1){throw "Expected exactly one pure helper: $name"}
  . ([scriptblock]::Create($fn[0].Extent.Text))
 }
 foreach($name in @('VANZY#1-0000/A2','VANZY#1-FFFF/A2','VANZY#1-1234/A2')) {
  if(-not (Test-VanzyProductName $name)){throw "Supported A2 rejected: $name"}
 }
 foreach($name in @('', 'VANZY', 'VANZY#2-0000/A2', 'VANZY#1-0000/A3', 'VANZY#1-000/A2', 'VANZY#1-00000/A2', 'VANZY#1-gggg/A2', 'VANZY#1-ffff/A2', "VANZY#1-0000/A2`n", "VANZY#1-0000/A2`r")) {
  if(Test-VanzyProductName $name){throw "Unsupported name accepted: $name"}
 }
 $a=[pscustomobject]@{Name='VANZY#1-0000/A2';Id='synthetic-a'}
 $b=[pscustomobject]@{Name='VANZY#1-FFFF/A2';Id='synthetic-b'}
 $other=[pscustomobject]@{Name='Other device';Id='synthetic-other'}
 if((Get-SingleVanzyTarget @($other,$a)).Id -cne 'synthetic-a'){throw 'Unique target not selected'}
 if((Get-SingleVanzyTarget @($b)).Id -cne 'synthetic-b'){throw 'Second suffix not supported'}
 foreach($items in @(@(),@($other),@($a,$b))) {
  $rejected=$false
  try {$null=Get-SingleVanzyTarget $items} catch {$rejected=$true}
  if(-not $rejected){throw 'Missing or ambiguous device list was not rejected'}
 }
}
'PASS: both workers support generic A2 suffixes and reject absent/ambiguous candidates; no transport executed.'
