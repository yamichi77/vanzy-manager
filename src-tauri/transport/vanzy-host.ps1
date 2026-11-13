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
public static class VanzyHostCleanup {
 // WinRT IClosable projects to IDisposable. Invoke the interface through the CLR,
 // not PowerShell's dynamic WinRT method adapter.
 public static void Dispose(object value) {
  if (value != null) ((IDisposable)value).Dispose();
 }
 public static string Failure(Exception error) {
  while(error.InnerException != null) error=error.InnerException;
  return error.GetType().FullName + " (HRESULT 0x" + error.HResult.ToString("X8") + "): " + error.Message;
 }
}
public static class VanzyHostJournal {
 // PowerShell 5.1 binds $null string arguments as empty strings. Keep null in C#.
 public static void Replace(string temporary, string destination) {
  System.IO.File.Replace(temporary, destination, null);
 }
}
public static class VanzyHostInput {
 public static volatile bool Stop;
 public static void Start() {
  var thread = new System.Threading.Thread(() => {
   try { string line; while ((line=Console.ReadLine()) != null) { if(line.Trim()=="STOP") break; } }
   catch {} finally { Stop=true; }
  }); thread.IsBackground=true; thread.Start();
 }
}
public sealed class VanzyHostNotification { public object Args; public long Tick; }
public sealed class VanzyNotifyCollector {
 private readonly ConcurrentQueue<object> events = new ConcurrentQueue<object>();
 public volatile bool Overflow;
 public void Capture(object sender, object args) { if(events.Count >= 4096) { Overflow=true; return; } events.Enqueue(new VanzyHostNotification { Args=args, Tick=System.Diagnostics.Stopwatch.GetTimestamp() }); }
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


# Dedicated EXTEND notifications only; no keyboard hook, driver, or SendInput.
# stdin STOP/EOF terminates; the owner must not kill this process to stop normally.
$dev=$null;$svc=$null;$rx=$null;$eventInfo=$null;$token=$null
$changedNotify=$false;$backupPath=$null;$mutex=$null;$mutexHeld=$false
$armed=$false;$armTick=[long]::MaxValue;$attempted=@{};$original=@{};$installed=@{};$byId=@{}
$recover=$false;$recoveryPath=$null;$recoveryRecord=$null;$journalEvidence=$null
$journalVersion=2;$snapshotIndices=1..11;$touchInverted=$null
$plan=@();$failure=$null;$restoration='not-needed';$restoreError=$null;$cleanupErrors=@()
function Emit($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Depth 10 -Compress)); [Console]::Out.Flush() }
function Check-Stop { if([VanzyHostInput]::Stop){throw 'Host stop requested'} }
function Event-Bytes($ev) {
 [byte[]]$bytes=[VanzyBufferReader]::Read($ev.Args.CharacteristicValue)
 if($armed -and -not [VanzyHostInput]::Stop -and $ev.Tick -ge $armTick -and $bytes.Length -eq 7 -and $bytes[0] -eq 0x31 -and $bytes[1] -eq 0 -and $bytes[2] -eq 0 -and $bytes[3] -eq 0xc0 -and $bytes[5] -eq 0 -and $bytes[6] -eq 0){
  $key=[string][int]$bytes[4]
  if($byId.ContainsKey($key)){Emit @{type='HOST_EVENT';id=[int]$bytes[4];index=$byId[$key];receivedAt=[DateTime]::UtcNow.ToString('o')}}
 }
 return ,$bytes
}
function Drain-Events {
 for($n=0;$n -lt 4096;$n++){ $event=$collector.Take();if($null -eq $event){break};$null=Event-Bytes $event }
 if($armed -and $collector.Overflow){throw 'Notification queue overflow; host session stopped'}
}
function Read-Command([byte]$command,[int]$index=-1) {
 if($command -notin 0x12,0x16,0x25,0x44,0x4b){throw 'Command not allowed'}
 if($command -eq 0x44 -and $index -notin (1..8)){throw 'Air index not verified'}
 if($command -eq 0x4b -and $index -notin (0..8)){throw 'Touch index not verified'}
 if($command -in 0x12,0x16,0x25 -and $index -ne -1){throw 'Unexpected index'}
 Drain-Events
 [byte[]]$packet=@(0x10,0,0,$command);if($index -ge 0){$packet += [byte]$index}
 Send-Packet $packet
 $deadline=[DateTime]::UtcNow.AddSeconds(6)
 while([DateTime]::UtcNow -lt $deadline){
  $event=$collector.Take();if($null -eq $event){Start-Sleep -Milliseconds 20;continue}
  [byte[]]$bytes=Event-Bytes $event
  if($bytes.Length -ge 4 -and ($bytes[0] -band 0xf0) -eq 0x20 -and $bytes[3] -eq $command){
   if($bytes[0] -ne 0x21 -or $bytes[1] -ne 0 -or $bytes[2] -ne 0){throw 'Unexpected response status/header'}
   if($index -ge 0){
    if($bytes.Length -lt 5 -or $bytes[4] -ne $index){continue}
    if($bytes.Length -ne 20){throw 'Unexpected map length'}
    return ,([byte[]]$bytes[5..19])
   }
   if($command -eq 0x25 -and ($bytes.Length -ne 5 -or $bytes[4] -notin 0,1)){throw 'Invalid touch inversion response'}
   if($command -eq 0x16 -and $bytes.Length -ne 5){throw 'Invalid runtime mode response'}
   if($bytes.Length -lt 5 -or $bytes.Length -gt 36){throw 'Unexpected firmware response'}
   return ,([byte[]]$bytes[4..($bytes.Length-1)])
  }
 }
 throw 'Response timed out; operation outcome may be uncertain'
}
function Map-Address([int]$index) {
 if($index -in (1..7)){return @{command=0x44;raw=$index}}
 switch($index){8{return @{command=0x4b;raw=0}};9{return @{command=0x4b;raw=3}};10{return @{command=0x4b;raw=7}};11{return @{command=0x4b;raw=8}};default{throw 'Unknown logical slot'}}
}
function Read-Map([int]$index) {
 $address=Map-Address $index
 return ,([byte[]](Read-Command $address.command $address.raw))
}
function Read-Touch-Inverted { $value=Read-Command 0x25;return [bool]($value[0] -eq 1) }
function Report-Runtime-Mode {
 $value=Read-Command 0x16
 Emit @{type='HOST_MODE';runtimeMode=[int]$value[0];modeReadAt=[DateTime]::UtcNow.ToString('o')}
 if([int]$value[0] -ne 2){throw 'This host mapping uses Gesture mode (runtime mode 2). Select that mode and read the device again. The runtime mode was not changed.'}
}
function Check-Inversion {
 if($journalVersion -eq 2 -and (Read-Touch-Inverted) -ne $touchInverted){throw 'Touch inversion changed; no further map writes allowed'}
}
function Write-Map([int]$index,[byte[]]$map) {
 if($index -notin (1..11) -or $map.Length -ne 15){throw 'Invalid map write'}
 $key=[string]$index
 if(-not $installed.ContainsKey($key) -or (-not (Equal-Bytes $map $installed[$key]) -and -not (Equal-Bytes $map $original[$key]))){throw 'Map outside authorized install/restore plan'}
 Check-Inversion
 $address=Map-Address $index
 Send-Packet ([byte[]](@(0x90,0,0,$address.command,$address.raw)+$map))
 Start-Sleep -Milliseconds 400
 [byte[]]$actual=Read-Map $index
 if(-not (Equal-Bytes $actual $map)){throw 'Map write readback mismatch; no automatic reapply'}
}
function Send-Packet([byte[]]$packet) {
 $buffer=[System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($packet)
 $wm=$tx.GetType().GetMethod('WriteValueAsync',[Type[]]@([Windows.Storage.Streams.IBuffer],[Windows.Devices.Bluetooth.GenericAttributeProfile.GattWriteOption]))
 if($null -eq $wm){throw 'GATT WriteValueAsync unavailable'}
 $ws=Await ($wm.Invoke($tx,@($buffer,[Windows.Devices.Bluetooth.GenericAttributeProfile.GattWriteOption]::WriteWithoutResponse))) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattCommunicationStatus])
 if($ws.ToString() -ne 'Success'){throw ('GATT transport failed: '+$ws)}
}
function Equal-Bytes($a,$b) { return (($a -join ',') -ceq ($b -join ',')) }
function Resolve-Journal {
 if($null -eq $backupPath){return}
 if([IO.File]::ReadAllText($backupPath) -cne $journalEvidence){throw 'Journal changed during session; not marking resolved'}
 $record.resolved=$true
 $record.resolvedAt=[DateTime]::UtcNow.ToString('o')
 $json=$record | ConvertTo-Json -Depth 8
 $bytes=[Text.Encoding]::UTF8.GetBytes($json)
 $temp=$backupPath+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
 $file=[IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try {$file.Write($bytes,0,$bytes.Length);$file.Flush($true)} finally {$file.Dispose()}
 if([IO.File]::ReadAllText($temp) -cne $json){throw 'Resolved journal readback failed'}
 [VanzyHostJournal]::Replace($temp,$backupPath)
 if([IO.File]::ReadAllText($backupPath) -cne $json){throw 'Resolved journal verification failed'}
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
try {
 $req=$env:VANZY_HOST_REQUEST | ConvertFrom-Json
 if($null -eq $req -or [string]::IsNullOrWhiteSpace([string]$req.deviceId)){throw 'Missing device identity'}
 $operation=[string]$req.operation
 if($operation -notin '','start','recover'){throw 'Operation rejected'}
 $recover=$operation -eq 'recover'
 if($recover){
  $restoration='recovery-not-started'
  if([string]::IsNullOrWhiteSpace([string]$req.backupDirectory) -or [string]::IsNullOrWhiteSpace([string]$req.recoveryPath)){throw 'Recovery directory/path missing'}
  $directory=[IO.Path]::GetFullPath([string]$req.backupDirectory).TrimEnd('\')
  $recoveryPath=[IO.Path]::GetFullPath([string]$req.recoveryPath)
  if(-not [string]::Equals([IO.Path]::GetDirectoryName($recoveryPath),$directory,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($recoveryPath) -notmatch '^host-recovery-[A-Za-z0-9-]+\.json$'){throw 'Recovery path is outside the owned journal directory or has an invalid name'}
  if(-not [IO.File]::Exists($recoveryPath)){throw 'Recovery journal missing'}
  $check=Get-Item -LiteralPath $recoveryPath -Force
  while($null -ne $check){
   if(($check.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Recovery paths must not traverse reparse points'}
   if($check -is [IO.FileInfo]){$check=$check.Directory}else{$check=$check.Parent}
  }
  $journalEvidence=[IO.File]::ReadAllText($recoveryPath)
  $recoveryRecord=$journalEvidence | ConvertFrom-Json
  if($recoveryRecord.schemaVersion -notin 1,2 -or $recoveryRecord.source -cne 'vanzy-host' -or $recoveryRecord.firmware -cne '3.2.1' -or (-not (Test-VanzyProductName ([string]$recoveryRecord.product))) -or $recoveryRecord.deviceId -cne $req.deviceId -or $recoveryRecord.resolved -isnot [bool] -or $recoveryRecord.resolved){throw 'Recovery journal identity/schema/state mismatch'}
  $journalVersion=[int]$recoveryRecord.schemaVersion
  if($journalVersion -eq 1){$snapshotIndices=1..4}else{if($recoveryRecord.touchInverted -isnot [bool]){throw 'Recovery inversion must be boolean'};$touchInverted=$recoveryRecord.touchInverted}
  $plan=@($recoveryRecord.plan)
 } else {
  if($req.expectedTouchInverted -isnot [bool]){throw 'Expected touch inversion must be boolean'}
  $touchInverted=$req.expectedTouchInverted;$plan=@($req.bindings)
 }
 if($plan.Count -lt 1 -or $plan.Count -gt $snapshotIndices.Count){throw 'Invalid binding count'}
 foreach($b in $plan){
  if(($b.index -isnot [int] -and $b.index -isnot [long]) -or ($b.id -isnot [int] -and $b.id -isnot [long])){throw 'Binding values must be integers'}
  if($b.index -notin $snapshotIndices -or $b.id -lt 1 -or $b.id -gt 11){throw 'Binding outside allowed range'}
  $key=[string]$b.index;$marker=[string]$b.id
  if($installed.ContainsKey($key) -or $byId.ContainsKey($marker)){throw 'Duplicate index or marker'}
  $installed[$key]=[byte[]](@(8,[int]$b.id,0)+(0,0,0,0,0,0,0,0,0,0,0,0))
  $byId[$marker]=[int]$b.index
 }
 foreach($i in $snapshotIndices){
  if($recover){$values=@($recoveryRecord.originalMaps.([string]$i))}else{$values=@($req.expectedMaps.([string]$i))}
  if($values.Count -ne 15){throw 'Expected exact maps for all snapshot slots'}
  foreach($v in $values){if(($v -isnot [int] -and $v -isnot [long]) -or $v -lt 0 -or $v -gt 255){throw 'Expected map must contain bytes'}}
  if($recover){$original[[string]$i]=[int[]]$values}
 }
 if($recover){
  foreach($b in $plan){
   $key=[string]$b.index;$values=@($recoveryRecord.markerMaps.$key)
   if($values.Count -ne 15){throw 'Invalid recovery marker length'}
   foreach($v in $values){if(($v -isnot [int] -and $v -isnot [long]) -or $v -lt 0 -or $v -gt 255){throw 'Invalid recovery marker byte'}}
   if(-not (Equal-Bytes $values $installed[$key])){throw 'Recovery marker differs from the fixed EXTEND plan'}
  }
 }
 $null=[IO.Path]::GetFullPath([string]$req.backupDirectory)
 if(-not [IO.Directory]::Exists([string]$req.backupDirectory)){throw 'Backup directory missing'}
 if(-not $recover){[VanzyHostInput]::Start();Check-Stop}
 $mutex=New-Object System.Threading.Mutex($false,'Local\VanzyManagerDeviceTransport')
 try {$mutexHeld=$mutex.WaitOne(0)} catch [System.Threading.AbandonedMutexException] {$mutexHeld=$true}
 if(-not $mutexHeld){throw 'Another VANZY operation is running'}
 if($recover -and [IO.File]::ReadAllText($recoveryPath) -cne $journalEvidence){throw 'Recovery journal changed before lock acquisition'}
 # Never adopt leftover markers from an interrupted session as a new original.
 if(-not $recover){foreach($journal in [IO.Directory]::GetFiles([IO.Path]::GetFullPath([string]$req.backupDirectory),'host-recovery-*.json')){
  $prior=[IO.File]::ReadAllText($journal) | ConvertFrom-Json
  if($prior.deviceId -ceq $req.deviceId -and $prior.resolved -ne $true){throw ('Unresolved host recovery journal requires recovery first: '+$journal)}
 }
 }
 $selector=[Windows.Devices.Bluetooth.BluetoothLEDevice]::GetDeviceSelectorFromPairingState($true)
 $devices=Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selector)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
 $target=Get-SingleVanzyTarget $devices
 $id=$target.Id
 if($req.deviceId -cne $id){throw 'Device identity changed'}
 $dev=Await ([Windows.Devices.Bluetooth.BluetoothLEDevice]::FromIdAsync($id)) ([Windows.Devices.Bluetooth.BluetoothLEDevice])
 if($null -eq $dev -or $dev.Name -cne $target.Name -or -not (Test-VanzyProductName ([string]$dev.Name))){throw 'Target device unavailable'}
 if($recover){if($dev.Name -cne $recoveryRecord.product){throw 'Recovery product identity changed'}} elseif($dev.Name -cne $req.expectedProduct){throw 'Device product identity changed'}
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

 if(-not $recover){Check-Stop}
 $firmware=[Text.Encoding]::UTF8.GetString((Read-Command 0x12))
 if($firmware -cne '3.2.1'){throw 'Unverified firmware; no settings written'}
 Check-Inversion
 if(-not $recover){Report-Runtime-Mode}
 if($recover){
  # Only validated journal data becomes a restore plan after device/FW verification.
  $backupPath=$recoveryPath
  $record=@{schemaVersion=$journalVersion;touchInverted=$touchInverted;source='vanzy-host';deviceId=$id;product=$dev.Name;firmware=$firmware;capturedAt=$recoveryRecord.capturedAt;maps=$original;installedMaps=$installed;bindings=$plan;originalMaps=$original;markerMaps=$installed;plan=$plan;resolved=$false}
  foreach($b in $plan){$attempted[[string]$b.index]=$true}
 } else {
 foreach($i in $snapshotIndices){$original[[string]$i]=[int[]](Read-Map $i)}
 foreach($i in $snapshotIndices){if(-not (Equal-Bytes $original[[string]$i] $req.expectedMaps.([string]$i))){throw 'Settings changed since preview; nothing written'}}
 # Inspect every FW-supported but unselected map before reserving an EXTEND ID.
 # These extra slots are read-only; UI/write routing remains the 11 analyzed gestures.
 $collisionCandidates=@();foreach($i in $snapshotIndices){if(-not $installed.ContainsKey([string]$i)){$collisionCandidates+=,([byte[]]$original[[string]$i])}}
 $extra=[byte[]](Read-Command 0x44 8);$collisionCandidates+=,$extra
 foreach($i in 1,2,4,5,6){$extra=[byte[]](Read-Command 0x4b $i);$collisionCandidates+=,$extra}
 foreach($map in $collisionCandidates){for($offset=0;$offset -lt 15;$offset+=3){
  if($map[$offset] -eq 0){break}
  if($map[$offset] -eq 8 -and $byId.ContainsKey([string][int]$map[$offset+1])){throw 'An unselected gesture already uses this EXTEND marker ID; nothing written'}
 }}

 $record=@{schemaVersion=$journalVersion;touchInverted=$touchInverted;source='vanzy-host';deviceId=$id;product=$dev.Name;firmware=$firmware;capturedAt=[DateTime]::UtcNow.ToString('o');maps=$original;installedMaps=$installed;bindings=$plan;originalMaps=$original;markerMaps=$installed;plan=$plan;resolved=$false}
 $backupPath=Save-Record $record 'host-recovery'
 $journalEvidence=[IO.File]::ReadAllText($backupPath)
 foreach($b in $plan){
  Check-Stop
  $key=[string]$b.index
  [byte[]]$current=Read-Map ([int]$b.index)
  if(-not (Equal-Bytes $current $original[$key])){throw 'Settings changed before installation'}
  if(-not (Equal-Bytes $current $installed[$key])){
   $attempted[$key]=$true # Set before transmission, including uncertain outcomes.
   Write-Map ([int]$b.index) $installed[$key]
  }
 }
 # Revalidate complete plan before arming; queued pre-arm notifications never trigger input.
 foreach($b in $plan){if(-not (Equal-Bytes (Read-Map ([int]$b.index)) $installed[[string]$b.index])){throw 'Installed map changed before arming'}}
 Check-Stop
 Drain-Events
 Report-Runtime-Mode
 $armTick=[Diagnostics.Stopwatch]::GetTimestamp();$armed=$true
 Emit @{type='HOST_READY';deviceId=$id;backupPath=$backupPath;bindings=$plan;touchInverted=$touchInverted}
 $nextModeRead=[DateTime]::UtcNow.AddSeconds(1)
 while(-not [VanzyHostInput]::Stop){
  if($recover){if($dev.Name -cne $recoveryRecord.product){throw 'Recovery product identity changed'}} elseif($dev.Name -cne $req.expectedProduct){throw 'Device product identity changed'}
 if($dev.ConnectionStatus -ne [Windows.Devices.Bluetooth.BluetoothConnectionStatus]::Connected){throw 'Device disconnected; stop session and verify restoration'}
  Drain-Events
  if([DateTime]::UtcNow -ge $nextModeRead){Report-Runtime-Mode;$nextModeRead=[DateTime]::UtcNow.AddSeconds(1)}
  Start-Sleep -Milliseconds 20
 }
 } # start-mode install/listen
} catch {$failure=$_.Exception.Message} finally {
 $armed=$false
 if($attempted.Count -gt 0){
  $restoration='unverified'
  try {
   try {Check-Inversion} catch {$restoration='blocked-inversion-change';throw}
   # Preflight the entire plan. An external edit blocks ALL restoration writes.
   $observed=@{}
   foreach($b in $plan){
    $key=[string]$b.index;$observed[$key]=[byte[]](Read-Map ([int]$b.index))
    if(-not (Equal-Bytes $observed[$key] $installed[$key]) -and -not (Equal-Bytes $observed[$key] $original[$key])){
     $restoration='blocked-external-change';throw 'External map change detected; no restoration writes performed'
    }
   }
   foreach($b in $plan){
    $key=[string]$b.index
    if(-not $attempted.ContainsKey($key)){continue}
    [byte[]]$now=Read-Map ([int]$b.index)
    if(Equal-Bytes $now $original[$key]){continue}
    if(-not (Equal-Bytes $now $installed[$key])){$restoration='blocked-external-change';throw 'External edit during restoration; remaining maps left unchanged'}
    Write-Map ([int]$b.index) $original[$key]
   }
   foreach($key in @($attempted.Keys)){
    if(-not (Equal-Bytes (Read-Map ([int]$key)) $original[$key])){throw 'Final restoration readback mismatch'}
   }
   $restoration='restored'
  } catch {$restoreError=$_.Exception.Message}
 }
 if($restoration -in 'restored','not-needed' -and $null -ne $backupPath){try {Resolve-Journal} catch {$cleanupErrors+=('Journal resolution failed: '+$_.Exception.Message)}}
 try {
  if($changedNotify -and $null -ne $rx){
   $status=Await ($rx.WriteClientCharacteristicConfigurationDescriptorAsync($old)) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattCommunicationStatus])
   if($status.ToString() -ne 'Success'){throw 'Notification subscription restoration failed'}
  }
 } catch {$cleanupErrors+= $_.Exception.Message}
 if($null -ne $eventInfo -and $null -ne $token){try {$eventInfo.GetRemoveMethod().Invoke($rx,@($token)) | Out-Null} catch {$cleanupErrors+= 'Notification handler removal failed'}}
 if($null -ne $svc){try {$svc.Dispose()} catch {$cleanupErrors+=('Service disposal failed: '+[VanzyHostCleanup]::Failure($_.Exception))}}
 # The short-lived worker owns this COM reference. Let process exit release it after terminal output.
 # Explicit BluetoothLEDevice.Dispose ends the PS5.1 pipeline before HOST_END on the verified device.
 if($mutexHeld){try {$mutex.ReleaseMutex()} catch {$cleanupErrors+='Mutex release failed'}}
 if($null -ne $mutex){try {$mutex.Dispose()} catch {$cleanupErrors+='Mutex disposal failed'}}
 # Emit within finally so pipeline termination cannot skip the terminal result.
 Emit @{type='HOST_END';ok=($null -eq $failure -and $null -eq $restoreError -and $cleanupErrors.Count -eq 0);error=$failure;backupPath=$backupPath;restoration=$restoration;restorationError=$restoreError;cleanupErrors=$cleanupErrors;attemptedIndices=@($attempted.Keys | ForEach-Object {[int]$_})}
}


