//! Dedicated VANZY notifications -> validated foreground key chords. No global keyboard hook.
use serde::{Deserialize,Serialize};
use std::{sync::{Arc,Mutex},io::{BufRead,BufReader,Write}};
use tauri::Manager;
use crate::{device::DeviceState,host_input};
#[derive(Clone,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct HostBinding { index:u8, keys:Vec<u16>, modifiers:u8 }
#[derive(Clone,Default,Serialize)]
#[serde(rename_all="camelCase")]
pub struct HostStatus { active:bool, phase:String, error:Option<String>, restored:Option<bool>,event_count:u64,last_gesture:Option<u8>,runtime_mode:Option<u8>,mode_read_at:Option<String>,last_received_at:Option<String> }
struct Session { input:Option<std::process::ChildStdin>,status:Arc<Mutex<HostStatus>> }
#[derive(Default)]
pub struct HostState(Mutex<Option<Session>>);
fn check(window:&tauri::WebviewWindow)->Result<(),String>{if window.label()!="main"||!cfg!(any(target_os="windows",target_os="macos")){return Err("Host conversion requires the local Windows or macOS window".into())}Ok(())}
#[tauri::command]
pub fn host_input_permission(window: tauri::WebviewWindow, request: bool) -> Result<bool, String> {
    check(&window)?;
    host_input::input_permission(request)
}
#[tauri::command]
pub fn host_status(window:tauri::WebviewWindow,app:tauri::AppHandle)->Result<HostStatus,String>{check(&window)?;let state=app.state::<HostState>();let guard=state.0.lock().map_err(|_|"Host state unavailable")?;match guard.as_ref(){Some(s)=>Ok(s.status.lock().map_err(|_|"Host status unavailable")?.clone()),None=>Ok(HostStatus{phase:"stopped".into(),..Default::default()})}}
#[tauri::command]
pub fn host_stop(window:tauri::WebviewWindow,app:tauri::AppHandle)->Result<HostStatus,String>{check(&window)?;request_stop(&app)?;host_status(window,app)}
pub fn request_stop(app:&tauri::AppHandle)->Result<(),String>{let state=app.state::<HostState>();let mut guard=state.0.lock().map_err(|_|"Host state unavailable")?;if let Some(s)=guard.as_mut(){if let Some(input)=s.input.as_mut(){let result=input.write_all(b"STOP\n").and_then(|_|input.flush());if let Ok(mut status)=s.status.lock(){status.phase="restoring".into();}result.map_err(|e|e.to_string())?;}}Ok(())}
pub fn is_active(app:&tauri::AppHandle)->bool {
 let state=app.state::<HostState>();
 let active = match state.0.lock(){
  Ok(guard)=>guard.as_ref().map(|s|s.status.lock().map(|v|v.active).unwrap_or(true)).unwrap_or(false),
  Err(_)=>true,
 };
 active
}
#[tauri::command]
pub fn host_start(window:tauri::WebviewWindow,app:tauri::AppHandle,snapshot_id:String,bindings:Vec<HostBinding>,observe_only:Option<bool>)->Result<HostStatus,String>{
 check(&window)?;
 #[cfg(not(any(target_os="windows",target_os="macos")))]{let _=(app,snapshot_id,bindings,observe_only);Err("Windows only".into())}
 #[cfg(any(target_os="windows",target_os="macos"))]{
 let observe_only=observe_only.unwrap_or(false);
 #[cfg(target_os="macos")]
 if !observe_only {host_input::ensure_input_permission()?;}
 if bindings.is_empty()||bindings.len()>11{return Err("Choose one to eleven analyzed gesture slots".into())}
 let mut seen=std::collections::HashSet::new();for b in &bindings{if !(1..=11).contains(&b.index)||!seen.insert(b.index){return Err("Invalid or repeated gesture".into())}if !observe_only {host_input::validate_chord(&b.keys,b.modifiers)?;}}
 let hs=app.state::<HostState>();let mut host=hs.0.lock().map_err(|_|"Host state unavailable")?;
 if host.as_ref().is_some_and(|s|s.status.lock().map(|v|v.active).unwrap_or(true)){return Err("Stop the current host session first".into())}
 let ds=app.state::<DeviceState>();let mut device=ds.0.try_lock().map_err(|_|"Another device operation is running")?;
 let before=device.current.as_ref().ok_or("Read and back up the device first")?;
 if before.snapshot_id!=snapshot_id{return Err("Stale snapshot; read device again".into())}
 let dir=app.path().app_data_dir().map_err(|e|e.to_string())?.join("device-backups");std::fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
 let request=serde_json::json!({"deviceId":before.device_id,"expectedProduct":before.product,"backupDirectory":dir,"expectedMaps":before.maps,"expectedTouchInverted":before.touch_inverted,"bindings":bindings.iter().map(|b|serde_json::json!({"index":b.index,"id":b.index})).collect::<Vec<_>>()});
 let mut child=worker_command(&app)?.env("VANZY_HOST_REQUEST",request.to_string()).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().map_err(|e|e.to_string())?;
 let input=child.stdin.take().ok_or("Missing worker input")?;let output=child.stdout.take().ok_or("Missing worker output")?;let error=child.stderr.take().ok_or("Missing worker error")?;
 device.current=None;
 let status=Arc::new(Mutex::new(HostStatus{active:true,phase:"starting".into(),..Default::default()}));let shared=status.clone();
 *host=Some(Session{input:Some(input),status});
 let app_clone=app.clone();
 std::thread::spawn(move||{
  let errors=std::thread::spawn(move||{use std::io::Read;let mut s=String::new();let _=error.take(8192).read_to_string(&mut s);s});
  let mut ready=false;let mut ended=false;
  for line in BufReader::new(output).lines(){let Ok(line)=line else{break};let Ok(value)=serde_json::from_str::<serde_json::Value>(&line)else{continue};
   match value["type"].as_str(){
    Some("HOST_MODE")=>{if let Some(mode)=value["runtimeMode"].as_u64().and_then(|x|u8::try_from(x).ok()){if let Ok(mut s)=shared.lock(){s.runtime_mode=Some(mode);s.mode_read_at=value["modeReadAt"].as_str().map(str::to_owned);}}},
    Some("HOST_READY")=>{if let Ok(mut s)=shared.lock(){if s.phase=="starting"{ready=true;s.phase="listening".into();}}},
    Some("HOST_EVENT") if ready=>{
     if !shared.lock().map(|s|s.phase=="listening").unwrap_or(false){continue;}
     let Some(id)=value["id"].as_u64().and_then(|x|u8::try_from(x).ok()) else{continue};let Some(binding)=bindings.iter().find(|b|b.index==id)else{continue};
     // Worker owns the exact BLE device and validates the 0xC0 packet before publishing.
     let result=if observe_only {Ok(())} else {host_input::emit_chord(&binding.keys,binding.modifiers)};
     if let Ok(mut s)=shared.lock(){s.event_count+=1;s.last_gesture=Some(binding.index);s.last_received_at=value["receivedAt"].as_str().map(str::to_owned);if let Err(e)=result {s.error=Some(e);s.phase="input-failed-restoring".into();ready=false;}}
     if !ready {let _=request_stop(&app_clone);}
    },
    Some("HOST_END")=>{ended=true;ready=false;if let Ok(mut s)=shared.lock(){s.active=false;s.restored=Some(value["restoration"].as_str()==Some("restored")||value["restoration"].as_str()==Some("not-needed"));s.phase=if s.restored==Some(true){"stopped"}else{"restore-failed"}.into();if value["ok"].as_bool()!=Some(true){s.error=Some(format!("{} / restoration: {} / cleanup: {}",value["error"].as_str().unwrap_or("Host session ended"),value["restorationError"].as_str().unwrap_or("none"),value["cleanupErrors"]));}}},
    _=>{}
   }
  }
  let exit_status=child.wait();let detail=errors.join().unwrap_or_default();if let Ok(mut s)=shared.lock(){s.active=false;if !ended{s.phase="restore-unconfirmed".into();s.restored=None;s.error=Some(format!("Host worker ended without confirmed restoration. Re-read device before any write. Exit: {:?}. {}",exit_status,detail));}}
 });
 Ok(HostStatus{active:true,phase:"starting".into(),..Default::default()})
 }
}
#[tauri::command]
pub fn host_recover(window:tauri::WebviewWindow,app:tauri::AppHandle)->Result<HostStatus,String>{
 check(&window)?;
 #[cfg(not(any(target_os="windows",target_os="macos")))]{let _=app;Err("Windows only".into())}
 #[cfg(any(target_os="windows",target_os="macos"))]{
 let state=app.state::<HostState>();let mut session=state.0.lock().map_err(|_|"Host state unavailable")?;
 if session.as_ref().is_some_and(|s|s.status.lock().map(|v|v.active).unwrap_or(true)){return Err("Stop the current session before recovery".into())}
 let directory=app.path().app_data_dir().map_err(|e|e.to_string())?.join("device-backups");
 let mut pending=Vec::new();for entry in std::fs::read_dir(&directory).map_err(|e|e.to_string())?{let entry=entry.map_err(|e|e.to_string())?;let name=entry.file_name().to_string_lossy().to_string();if !name.starts_with("host-recovery-")||!name.ends_with(".json"){continue}let value:serde_json::Value=serde_json::from_slice(&std::fs::read(entry.path()).map_err(|e|e.to_string())?).map_err(|e|format!("Recovery record invalid: {e}"))?;if value["resolved"].as_bool()==Some(false){pending.push((entry.path(),value));}}
 if pending.len()!=1{return Err(format!("Expected exactly one unresolved host backup, found {}. No device changes.",pending.len()))}
 let device_state=app.state::<DeviceState>();
 let mut device=device_state.0.try_lock().map_err(|_|"Another device operation is running")?;
 let (path,record)=pending.pop().unwrap();let device_id=record["deviceId"].as_str().ok_or("Recovery device identity missing")?;
 let request=serde_json::json!({"operation":"recover","deviceId":device_id,"backupDirectory":directory,"recoveryPath":path});
 let mut child=worker_command(&app)?.env("VANZY_HOST_REQUEST",request.to_string()).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn().map_err(|e|e.to_string())?;
 let output=child.stdout.take().ok_or("Missing recovery output")?;
 let status=Arc::new(Mutex::new(HostStatus{active:true,phase:"restoring".into(),..Default::default()}));let shared=status.clone();*session=Some(Session{input:None,status});
 device.current=None;
 std::thread::spawn(move||{let mut ended=false;for line in BufReader::new(output).lines(){let Ok(line)=line else{break};let Ok(v)=serde_json::from_str::<serde_json::Value>(&line)else{continue};if v["type"]=="HOST_END"{ended=true;if let Ok(mut s)=shared.lock(){s.active=false;s.restored=Some(v["restoration"]=="restored"||v["restoration"]=="not-needed");s.phase=if s.restored==Some(true){"stopped"}else{"restore-failed"}.into();if v["ok"]!=true{s.error=Some(format!("{} / {} / {}",v["error"],v["restorationError"],v["cleanupErrors"]));}}}}let _=child.wait();if !ended{if let Ok(mut s)=shared.lock(){s.active=false;s.phase="restore-unconfirmed".into();s.error=Some("Recovery ended without confirmation; do not retry writes".into());}}});
 Ok(HostStatus{active:true,phase:"restoring".into(),..Default::default()})
 }
}



#[cfg(target_os="windows")]
fn worker_command(_: &tauri::AppHandle)->Result<std::process::Command,String>{
 use std::os::windows::process::CommandExt;
 let executable=std::path::PathBuf::from(std::env::var_os("SystemRoot").ok_or("Missing SystemRoot")?).join("System32/WindowsPowerShell/v1.0/powershell.exe");
 let mut command=std::process::Command::new(executable);
 command.args(["-NoLogo","-NoProfile","-NonInteractive","-Command",include_str!("../transport/vanzy-host.ps1")]).creation_flags(0x08000000);
 Ok(command)
}
#[cfg(target_os="macos")]
fn worker_command(app:&tauri::AppHandle)->Result<std::process::Command,String>{crate::mac_worker::command(app,true)}
