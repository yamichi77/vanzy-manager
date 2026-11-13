# Known A2 family only. Device identity and firmware are checked separately.
function Test-VanzyProductName([string]$name) {
 return $null -ne $name -and $name -cmatch '\AVANZY#1-[0-9A-F]{4}/A2\z'
}
# Do not silently choose among paired units, even if only one is awake.
function Get-SingleVanzyTarget($devices) {
 $targets=@($devices | Where-Object {Test-VanzyProductName ([string]$_.Name)})
 if($targets.Count -ne 1){throw 'Exactly one already-paired VANZY A2 is required; no pairing or automatic selection was attempted'}
 return $targets[0]
}
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Devices.Bluetooth.BluetoothLEDevice,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
$null=[Windows.Devices.Bluetooth.BluetoothConnectionStatus,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
$null=[Windows.Devices.Enumeration.DeviceInformation,Windows.Devices.Enumeration,ContentType=WindowsRuntime]
$null=[Windows.Devices.Enumeration.DeviceInformationCollection,Windows.Devices.Enumeration,ContentType=WindowsRuntime]
function Await($operation,[Type]$resultType){
 $method=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'} | Select-Object -First 1
 $task=$method.MakeGenericMethod($resultType).Invoke($null,@($operation))
 if(-not $task.Wait(10000)){try {$operation.Cancel()} catch {}; throw 'WinRT operation timed out; cancellation requested, result may be uncertain'}
 $task.Result
}
Add-Type -TypeDefinition @"
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
public static class VanzyBufferReader {
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int GetLength(IntPtr self, out uint value);
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int GetBuffer(IntPtr self, out IntPtr value);
 public static byte[] Read(object value) {
  IntPtr unk=IntPtr.Zero, ibuf=IntPtr.Zero, access=IntPtr.Zero;
  try {
   unk=Marshal.GetIUnknownForObject(value);
   Guid bi=new Guid("905a0fe0-bc53-11df-8c49-001e4fc686da");
   Marshal.ThrowExceptionForHR(Marshal.QueryInterface(unk,ref bi,out ibuf));
   IntPtr vt=Marshal.ReadIntPtr(ibuf);
   GetLength length=(GetLength)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vt,7*IntPtr.Size),typeof(GetLength));
   uint n; Marshal.ThrowExceptionForHR(length(ibuf,out n));
   if(n>512) throw new InvalidOperationException("Oversized BLE response");
   Guid ba=new Guid("905a0fef-bc53-11df-8c49-001e4fc686da");
   Marshal.ThrowExceptionForHR(Marshal.QueryInterface(unk,ref ba,out access));
   GetBuffer data=(GetBuffer)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(access),3*IntPtr.Size),typeof(GetBuffer));
   IntPtr ptr; Marshal.ThrowExceptionForHR(data(access,out ptr));
   byte[] result=new byte[n]; Marshal.Copy(ptr,result,0,(int)n); return result;
  } finally { if(access!=IntPtr.Zero)Marshal.Release(access); if(ibuf!=IntPtr.Zero)Marshal.Release(ibuf); if(unk!=IntPtr.Zero)Marshal.Release(unk); }
 }
}
public sealed class VanzyNotifyCollector {
 private readonly ConcurrentQueue<object> events = new ConcurrentQueue<object>();
 public void Capture(object sender, object args) { events.Enqueue(args); }
 public object Take() { object value; return events.TryDequeue(out value) ? value : null; }
}
"@
$null=[Windows.Devices.Bluetooth.BluetoothCacheMode,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
$null=[Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceServicesResult,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
$null=[Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicsResult,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
$null=[Windows.Devices.Bluetooth.GenericAttributeProfile.GattReadClientCharacteristicConfigurationDescriptorResult,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
$null=[Windows.Devices.Bluetooth.GenericAttributeProfile.GattClientCharacteristicConfigurationDescriptorValue,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
$null=[Windows.Devices.Bluetooth.GenericAttributeProfile.GattCommunicationStatus,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
$null=[Windows.Devices.Bluetooth.GenericAttributeProfile.GattWriteOption,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.IBuffer,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.DataWriter,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime]

# Fixed transport used by the native app only. No firmware/reset/pairing operations.
# Read requests write a query packet to the command characteristic, never settings.
$dev=$null; $svc=$null; $rx=$null; $eventInfo=$null; $token=$null
$changedNotify=$false; $settingWriteSent=$false; $backupPath=$null; $result=$null
$mutex=$null; $mutexHeld=$false
function Send-Packet([byte[]]$packet) {
 $buffer=[System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($packet)
 $wm=$tx.GetType().GetMethod('WriteValueAsync',[Type[]]@([Windows.Storage.Streams.IBuffer],[Windows.Devices.Bluetooth.GenericAttributeProfile.GattWriteOption]))
 if($null -eq $wm){throw 'GATT WriteValueAsync unavailable'}
 $ws=Await ($wm.Invoke($tx,@($buffer,[Windows.Devices.Bluetooth.GenericAttributeProfile.GattWriteOption]::WriteWithoutResponse))) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattCommunicationStatus])
 if($ws.ToString() -ne 'Success'){throw ('GATT transport failed: '+$ws)}
}
function Read-Command([byte]$command, [int]$index=-1) {
 if($command -notin 0x12,0x25,0x44,0x4B){throw 'Command not allowed'}
 if($command -eq 0x44 -and $index -notin 1,2,3,4,5,6,7){throw 'Index not verified'}
 if($command -eq 0x4B -and $index -notin 0,3,7,8){throw 'Touch index not verified'}
 if($command -in 0x12,0x25 -and $index -ne -1){throw 'Unexpected index'}
 while($null -ne $collector.Take()){}
 [byte[]]$packet=@(0x10,0,0,$command); if($index -ge 0){$packet += [byte]$index}
 Send-Packet $packet
 $deadline=[DateTime]::UtcNow.AddSeconds(6)
 while([DateTime]::UtcNow -lt $deadline){
  $ev=$collector.Take(); if($null -eq $ev){Start-Sleep -Milliseconds 20;continue}
  [byte[]]$bytes=[VanzyBufferReader]::Read($ev.CharacteristicValue)
  if($bytes.Length -ge 4 -and ($bytes[0] -band 0xf0) -eq 0x20 -and $bytes[3] -eq $command){
   if($bytes[0] -ne 0x21 -or $bytes[1] -ne 0 -or $bytes[2] -ne 0){throw 'Unexpected response status/header'}
   if($index -ge 0){
    if($bytes.Length -lt 5 -or $bytes[4] -ne $index){continue}
    if($bytes.Length -ne 20){throw 'Unexpected map length'}
    return ,([byte[]]$bytes[5..19])
   }
   if($command -eq 0x25){if($bytes.Length -ne 5 -or $bytes[4] -gt 1){throw 'Invalid touch inversion response'};return ,([byte[]]@($bytes[4]))}
   if($bytes.Length -lt 5 -or $bytes.Length -gt 36){throw 'Unexpected firmware response'}
   return ,([byte[]]$bytes[4..($bytes.Length-1)])
  }
 }
 throw 'Response timed out; reconnect/read before any further write'
}
function Slot([int]$id) {
 if($id -in 1..7){return @(0x44,$id)}
 switch($id){8{return @(0x4B,0)};9{return @(0x4B,3)};10{return @(0x4B,7)};11{return @(0x4B,8)};default{throw 'Unknown logical slot'}}
}
function Read-AllMaps {
 $all=@{};foreach($i in 1..11){$slot=Slot $i;$all[[string]$i]=[int[]](Read-Command $slot[0] $slot[1])};return $all
}
function Equal-Bytes($a,$b) { return (($a -join ',') -ceq ($b -join ',')) }
# Pure allowlist, shared by the fixed apply path and offline tests only.
# Identity/FW checks in the transport remain mandatory before any settings write.
function Test-AllowedApplyMap([int]$index,$target) {
 if($index -notin 1..11 -or $target.Count -ne 15){return $false}
 foreach($v in $target){if(($v -isnot [int] -and $v -isnot [long]) -or $v -lt 0 -or $v -gt 255){return $false}}
 if(@($target[3..14] | Where-Object {$_ -ne 0}).Count -ne 0){return $false}
 if($target[0] -eq 5 -and $target[1] -le 15 -and ($target[2] -in ((4..56)+(58..69)+(73..82)) -or ($target[1] -eq 8 -and $target[2] -eq 0))){return $true}
 # Exact per-slot FW 3.2.1 initialization defaults, not arbitrary mouse/media actions.
 $defaults=@{
  1=@(5,0,80);2=@(5,0,79);3=@(5,8,43);4=@(5,0,40)
  5=@(4,1,0);6=@(4,0,0);7=@(4,3,0)
  8=@(1,22,0);9=@(1,24,0);10=@(1,16,0);11=@(1,17,0)
 }
 return (Equal-Bytes $target[0..2] $defaults[$index])
}
function Save-Record($record,[string]$kind) {
 $directory=[IO.Path]::GetFullPath([string]$req.backupDirectory)
 if(-not [IO.Directory]::Exists($directory)){throw 'Backup directory missing'}
 $path=Join-Path $directory ($kind+'-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff')+'-'+[Guid]::NewGuid().ToString('N')+'.json')
 $json=$record | ConvertTo-Json -Depth 8
 $bytes=[Text.Encoding]::UTF8.GetBytes($json)
 $file=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try {$file.Write($bytes,0,$bytes.Length);$file.Flush($true)} finally {$file.Dispose()}
 if([IO.File]::ReadAllText($path) -cne $json){throw 'Backup readback verification failed'}
 return $path
}
function Assert-HostRecoveryResolved([string]$directory) {
 if([string]::IsNullOrWhiteSpace($directory) -or -not [IO.Directory]::Exists($directory)){throw 'Host recovery directory unavailable; ordinary writes blocked'}
 foreach($path in [IO.Directory]::GetFiles($directory,'host-recovery-*.json')){
  if((Get-Item -LiteralPath $path).Length -gt 262144){throw 'Host recovery record oversized; ordinary writes blocked'}
  $record=[IO.File]::ReadAllText($path) | ConvertFrom-Json
  if($record.schemaVersion -notin 1,2 -or $record.source -cne 'vanzy-host' -or (-not (Test-VanzyProductName ([string]$record.product))) -or $record.firmware -cne '3.2.1' -or [string]::IsNullOrWhiteSpace([string]$record.deviceId) -or $record.resolved -isnot [bool]){throw 'Invalid host recovery record; ordinary writes blocked'}
  if(-not $record.resolved){throw 'Unresolved host restoration; recover before changing any device map'}
 }
}
try {
 $req=$env:VANZY_MANAGER_REQUEST | ConvertFrom-Json
 if($req.operation -notin 'read','apply','restore'){throw 'Operation rejected'}
 $mutex=New-Object System.Threading.Mutex($false,'Local\VanzyManagerDeviceTransport')
 try {$mutexHeld=$mutex.WaitOne(0)} catch [System.Threading.AbandonedMutexException] {$mutexHeld=$true}
 if(-not $mutexHeld){throw 'Another VANZY operation is running'}
 # Check under the shared transport lock, including after an app restart.
 # Reads remain available for diagnosis; apply and restore both fail closed.
 if($req.operation -ne 'read'){Assert-HostRecoveryResolved ([string]$req.backupDirectory)}
 $selector=[Windows.Devices.Bluetooth.BluetoothLEDevice]::GetDeviceSelectorFromPairingState($true)
 $devices=Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selector)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
 $target=Get-SingleVanzyTarget $devices
 $id=$target.Id
 if($req.operation -ne 'read' -and $req.deviceId -cne $id){throw 'Device identity changed'}
 $dev=Await ([Windows.Devices.Bluetooth.BluetoothLEDevice]::FromIdAsync($id)) ([Windows.Devices.Bluetooth.BluetoothLEDevice])
 if($null -eq $dev -or $dev.Name -cne $target.Name -or -not (Test-VanzyProductName ([string]$dev.Name))){throw 'Target device unavailable'}
 if($req.operation -ne 'read' -and $dev.Name -cne $req.expectedProduct){throw 'Device product identity changed'}
 if($dev.ConnectionStatus -ne [Windows.Devices.Bluetooth.BluetoothConnectionStatus]::Connected){throw 'VANZY is disconnected; wake/connect it in Windows first'}
 $sr=Await ($dev.GetGattServicesForUuidAsync([guid]'0000c0a1-0000-1000-8000-00805f9b34fb',[Windows.Devices.Bluetooth.BluetoothCacheMode]::Uncached)) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceServicesResult])
 if($sr.Status.ToString() -ne 'Success' -or $sr.Services.Count -ne 1){throw 'Expected exactly one command service'}
 $svc=$sr.Services[0]
 $cr=Await ($svc.GetCharacteristicsAsync([Windows.Devices.Bluetooth.BluetoothCacheMode]::Uncached)) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicsResult])
 if($cr.Status.ToString() -ne 'Success'){throw 'Could not enumerate command characteristics'}
 $rx=$cr.Characteristics | Where-Object {$_.Uuid -eq [guid]'d7b83c07-eae9-469c-ba5c-12db92c7cfa2'}
 $tx=$cr.Characteristics | Where-Object {$_.Uuid -eq [guid]'08202fb0-fab1-4a34-86a2-8b2738ebdf9f'}
 if($null -eq $rx -or $null -eq $tx){throw 'Missing command characteristics'}
 $collector=New-Object VanzyNotifyCollector
 $eventInfo=$rx.GetType().GetEvent('ValueChanged')
 $handler=[Delegate]::CreateDelegate($eventInfo.EventHandlerType,$collector,$collector.GetType().GetMethod('Capture'))
 $token=$eventInfo.GetAddMethod().Invoke($rx,@($handler))
 $cc=Await ($rx.ReadClientCharacteristicConfigurationDescriptorAsync()) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattReadClientCharacteristicConfigurationDescriptorResult])
 if($cc.Status.ToString() -ne 'Success'){throw 'Could not read notification configuration'}
 $old=$cc.ClientCharacteristicConfigurationDescriptor
 if($old.ToString() -eq 'None'){
  $changedNotify=$true # Cleanup even if the enable request has an uncertain outcome.
  $ns=Await ($rx.WriteClientCharacteristicConfigurationDescriptorAsync([Windows.Devices.Bluetooth.GenericAttributeProfile.GattClientCharacteristicConfigurationDescriptorValue]::Notify)) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattCommunicationStatus])
  if($ns.ToString() -ne 'Success'){throw 'Notification subscription failed'}
  $changedNotify=$true
 } elseif($old.ToString() -ne 'Notify'){throw 'Unexpected existing notification configuration'}
 $firmware=[Text.Encoding]::UTF8.GetString((Read-Command 0x12))
 if($firmware -cne '3.2.1'){throw ('Unverified firmware '+$firmware+'; no settings written')}
 $touchInverted=([int](Read-Command 0x25)[0] -eq 1)
 $maps=Read-AllMaps
 if(([int](Read-Command 0x25)[0] -eq 1) -ne $touchInverted){throw 'Touch inversion changed while reading'}
 $record=@{schemaVersion=2;touchInverted=$touchInverted;source='vanzy-live';deviceId=$id;product=$dev.Name;firmware=$firmware;capturedAt=[DateTime]::UtcNow.ToString('o');maps=$maps}
 $backupPath=Save-Record $record 'before'
 if($req.operation -ne 'read') {
  if($req.expectedTouchInverted -isnot [bool] -or $req.expectedTouchInverted -ne $touchInverted){throw 'Touch inversion changed; nothing written'}
  foreach($i in 1..11){if(-not (Equal-Bytes $maps[[string]$i] $req.expectedMaps.([string]$i))){throw 'Settings changed since the preview; nothing written'}}
  $index=[int]$req.index
  $slot=Slot $index
  $target=@($req.target)
  if($target.Count -ne 15){throw 'Invalid map length'}
  foreach($v in $target){if($v -isnot [int] -and $v -isnot [long]){throw 'Map must contain integers'};if($v -lt 0 -or $v -gt 255){throw 'Map byte outside range'}}
  if($req.operation -eq 'apply'){
   if(-not (Test-AllowedApplyMap $index $target)){throw 'Only a verified keyboard action or the exact FW 3.2.1 default for this slot is supported'}
  }
  # Restore bytes come only from the native process's trusted prior live snapshot.
  if(Equal-Bytes $maps[[string]$index] $target){throw 'No change to write'}
  if(([int](Read-Command 0x25)[0] -eq 1) -ne $touchInverted){throw 'Touch inversion changed before write; nothing written'}
  $settingWriteSent=$true
  Send-Packet ([byte[]](@(0x90,0,0,$slot[0],$slot[1])+$target))
  Start-Sleep -Milliseconds 400
  [int[]]$actual=Read-Command $slot[0] $slot[1]
  if(-not (Equal-Bytes $actual $target)){throw 'Readback mismatch; state uncertain, stop and read again. Backup preserved'}
  $maps[[string]$index]=$actual
  if(([int](Read-Command 0x25)[0] -eq 1) -ne $touchInverted){throw 'Touch inversion changed during write'}
  $verified=Read-AllMaps
  foreach($i in 1..11){if(-not (Equal-Bytes $maps[[string]$i] $verified[[string]$i])){throw 'Another map changed during write; stop and re-read'}}
  if(([int](Read-Command 0x25)[0] -eq 1) -ne $touchInverted){throw 'Touch inversion changed during verification'}
  $record.capturedAt=[DateTime]::UtcNow.ToString('o')
  $null=Save-Record $record 'verified'
 }
 $result=@{ok=$true;snapshot=$record;backupPath=$backupPath;settingWriteSent=$settingWriteSent}
} catch {
 $result=@{ok=$false;error=$_.Exception.Message;settingWriteSent=$settingWriteSent;backupPath=$backupPath}
} finally {
 try {
  if($changedNotify -and $null -ne $rx){
   $restore=Await ($rx.WriteClientCharacteristicConfigurationDescriptorAsync($old)) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattCommunicationStatus])
   if($restore.ToString() -ne 'Success'){throw 'Could not restore notification subscription'}
  }
 } catch {$result=@{ok=$false;error=('Notification cleanup failed: '+$_.Exception.Message);settingWriteSent=$settingWriteSent;backupPath=$backupPath}}
 if($null -ne $eventInfo -and $null -ne $token){try {$eventInfo.GetRemoveMethod().Invoke($rx,@($token)) | Out-Null} catch {}}
 if($null -ne $svc){try {$svc.Dispose()} catch {}}
 if($null -ne $dev){try {$dev.Dispose()} catch {}}
 if($mutexHeld){$mutex.ReleaseMutex()};if($null -ne $mutex){$mutex.Dispose()}
}
'VANZY_RESULT:'+($result | ConvertTo-Json -Depth 8 -Compress)


