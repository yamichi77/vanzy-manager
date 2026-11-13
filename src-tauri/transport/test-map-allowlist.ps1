# Offline test: parse the worker and execute ONLY its two pure allowlist helpers.
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'vanzy-windows.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors | Out-String)}
foreach($name in @('Equal-Bytes','Test-AllowedApplyMap')){
 $fn=$ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$false) | Where-Object {$_.Name -ceq $name}
 if(@($fn).Count -ne 1){throw "Expected exactly one pure helper: $name"}
 . ([scriptblock]::Create($fn.Extent.Text))
}
function Assert-Allowed($index,$value,[bool]$expected){
 if((Test-AllowedApplyMap $index $value) -ne $expected){throw "Unexpected allowlist result: slot=$index bytes=$($value -join ',') expected=$expected"}
}
$defaults=@{
 1=@(5,0,80);2=@(5,0,79);3=@(5,8,43);4=@(5,0,40)
 5=@(4,1,0);6=@(4,0,0);7=@(4,3,0)
 8=@(1,22,0);9=@(1,24,0);10=@(1,16,0);11=@(1,17,0)
}
foreach($index in 1..11){Assert-Allowed $index ($defaults[$index]+@(0)*12) $true}
foreach($index in 5..11){
 $value=$defaults[$index]+@(0)*12
 foreach($other in 0..12){Assert-Allowed $other $value ($other -eq $index)}
 foreach($offset in 0..14){$changed=$value.Clone();$changed[$offset]=$changed[$offset] -bxor 128;Assert-Allowed $index $changed $false}
 Assert-Allowed $index $value[0..13] $false
 Assert-Allowed $index ($value+@(0)) $false
}
foreach($index in 1..11){
 Assert-Allowed $index (@(5,3,80)+@(0)*12) $true
 Assert-Allowed $index (@(5,8,0)+@(0)*12) $true
}
foreach($index in @(0,12,255)){Assert-Allowed $index (@(5,0,80)+@(0)*12) $false}
foreach($value in @(@(5,0,0),@(5,16,80),@(5,0,57),@(5,0,70),@(5,0,227),@(4,2,0),@(1,23,0))){Assert-Allowed 5 ($value+@(0)*12) $false}
Assert-Allowed 5 @() $false
Assert-Allowed 5 (@(0)*15) $false
Assert-Allowed 5 (@(4,1,0)+@(0)*11+@(256)) $false
Assert-Allowed 5 (@(4,1,0)+@(0)*11+@(-1)) $false
Assert-Allowed 5 (@(4,1,0)+@(0)*11+@('0')) $false
'PASS: worker syntax and pure per-slot FW-default/keyboard allowlist; no transport executed.'
