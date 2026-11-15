//! Host-only, bounded macros. No transport/device mutation and no shell evaluation.
use serde::{Deserialize,Serialize};
use std::{sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};
use tauri::Manager;
#[derive(Clone,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Macro {pub version:u8,pub steps:Vec<Step>}
#[derive(Clone,Deserialize)]
#[serde(tag="type",deny_unknown_fields)]
pub enum Step {
 #[serde(rename="key")] Key{keys:Vec<u16>,modifiers:u8,#[serde(default,rename="targetApp")]target_app:Option<String>},
 #[serde(rename="wait")] Wait{ms:u64},
 #[serde(rename="openApp")] OpenApp{app:String,#[serde(rename="timeoutMs")]timeout_ms:u64},
 #[serde(rename="openUrl")] OpenUrl{url:String,app:String,#[serde(rename="timeoutMs")]timeout_ms:u64},
}
#[derive(Clone,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MacroBinding {pub index:u8,pub r#macro:Macro}
#[derive(Clone,Default,Serialize)]
pub struct Status {pub running:bool,pub step:Option<usize>,pub error:Option<String>}
pub static ACTIVITY_GATE:Mutex<()>=Mutex::new(());
#[derive(Default)]
pub struct MacroState {status:Arc<Mutex<Status>>,cancel:Arc<AtomicBool>}
fn app_valid(app:&str)->bool {app.len()<=255 && app.contains('.') && app.split('.').all(|p|!p.is_empty()&&p.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_'))}
pub fn validate(m:&Macro)->Result<(),String>{
 if m.version!=1 || m.steps.is_empty() || m.steps.len()>32{return Err("Macro requires version 1 and 1–32 steps".into())}
 let mut waits=0u64;let mut budget=0u64;
 for s in &m.steps {match s {
  Step::Key{keys,modifiers,target_app}=>{if target_app.as_ref().is_some_and(|app|!app_valid(app)){return Err("Invalid target application bundle ID".into())}crate::host_input::validate_chord(keys,*modifiers)?;},
  Step::Wait{ms}=>{if *ms>10000{return Err("Wait exceeds 10000 ms".into())}waits+=*ms;budget+=*ms;if waits>10000{return Err("Total waits must not exceed 10000 ms".into())}},
  Step::OpenApp{app,timeout_ms}|Step::OpenUrl{app,timeout_ms,..}=>{if !app_valid(app)||!(100..=10000).contains(timeout_ms){return Err("Valid application bundle ID and timeout 100–10000 ms required".into())}budget+=*timeout_ms;}
 };if budget>60000{return Err("Macro configured duration exceeds 60000 ms".into())}if let Step::OpenUrl{url,..}=s {
  // HTTPS and application URI schemes only; no files, shell/script/data handlers,
  // credentials, whitespace or command-line options. Values never appear in errors.
  let parsed=tauri::Url::parse(url).map_err(|_|"Invalid URL")?;
  if url.len()>4096||url.chars().any(|c|c.is_control()||c.is_whitespace())||!parsed.username().is_empty()||parsed.password().is_some()||matches!(parsed.scheme(),"file"|"javascript"|"data"|"vbscript"|"shell"|"command"|"powershell"|"cmd"|"osascript"|"applescript") {return Err("Unsupported URL scheme or unsafe URL".into())}
 }} Ok(())
}
pub fn is_running(app:&tauri::AppHandle)->bool{app.state::<MacroState>().status.lock().map(|s|s.running).unwrap_or(true)}
pub fn cancel(app:&tauri::AppHandle){app.state::<MacroState>().cancel.store(true,Ordering::SeqCst);}
#[tauri::command]
pub fn macro_cancel(window:tauri::WebviewWindow,app:tauri::AppHandle)->Result<(),String>{check(&window)?;cancel(&app);Ok(())}
#[tauri::command]
pub fn macro_status(window:tauri::WebviewWindow,app:tauri::AppHandle)->Result<Status,String>{check(&window)?;let value=app.state::<MacroState>().status.lock().map_err(|_|"Macro state unavailable")?.clone();Ok(value)}
fn check(w:&tauri::WebviewWindow)->Result<(),String>{if w.label()!="main"{Err("Local main window required".into())}else{Ok(())}}
#[tauri::command]
pub fn macro_test(window:tauri::WebviewWindow,app:tauri::AppHandle,r#macro:Macro)->Result<(),String>{check(&window)?;let _gate=ACTIVITY_GATE.lock().map_err(|_|"Activity gate unavailable")?;let mut target=false;for step in &r#macro.steps{match step{Step::OpenApp{app,..}|Step::OpenUrl{app,..}=>{target=app!="dev.vanzy.manager.demo"},Step::Key{..} if !target=>return Err("Test keys require an explicit non-Manager application target".into()),_=>{}}}if crate::host::is_active(&app)||crate::device::is_busy(&app){return Err("Stop the host session before a macro test".into())}start(&app,r#macro)}
pub fn start(app:&tauri::AppHandle,m:Macro)->Result<(),String>{
 validate(&m)?;adapter_supported()?;
 let state=app.state::<MacroState>();let mut status=state.status.lock().map_err(|_|"Macro state unavailable")?;
 if status.running{return Ok(())} // Drop: never queue/replay triggers.
 *status=Status{running:true,..Default::default()};state.cancel.store(false,Ordering::SeqCst);
 let status=state.status.clone();let cancel=state.cancel.clone();
 std::thread::spawn(move||{let result=run(&m,&cancel,|n|{if let Ok(mut s)=status.lock(){s.step=Some(n)}});if let Ok(mut s)=status.lock(){s.running=false;s.error=result.err();}});Ok(())
}
pub fn adapter_supported()->Result<(),String>{if cfg!(target_os="macos"){Ok(())}else{Err("Macro OS adapter is not verified on this platform; existing key assignments remain available".into())}}
fn guard(cancel:&AtomicBool,deadline:Instant)->Result<(),String>{if cancel.load(Ordering::SeqCst){Err("Macro cancelled".into())}else if Instant::now()>=deadline{Err("Macro execution timed out".into())}else{Ok(())}}
trait Adapter {
 fn foreground(&mut self)->Result<String,String>;
 fn launch(&mut self,args:&[&str],cancel:&AtomicBool,deadline:Instant)->Result<(),String>;
 fn chord(&mut self,keys:&[u16],modifiers:u8)->Result<(),String>;
}
struct NativeAdapter;
impl Adapter for NativeAdapter {
 fn foreground(&mut self)->Result<String,String>{frontmost()}
 fn launch(&mut self,args:&[&str],cancel:&AtomicBool,deadline:Instant)->Result<(),String>{open(args,cancel,deadline)}
 fn chord(&mut self,keys:&[u16],modifiers:u8)->Result<(),String>{crate::host_input::emit_chord(keys,modifiers)}
}
fn run(m:&Macro,cancel:&AtomicBool,progress:impl FnMut(usize))->Result<(),String>{run_with(m,cancel,progress,&mut NativeAdapter)}
fn run_with(m:&Macro,cancel:&AtomicBool,mut progress:impl FnMut(usize),io:&mut impl Adapter)->Result<(),String>{
 let deadline=Instant::now()+Duration::from_secs(60);
 for (index,step) in m.steps.iter().enumerate(){progress(index+1);guard(cancel,deadline)?;
  match step {
   Step::Key{keys,modifiers,target_app}=>{
    // App identity is an optional per-key guard, not a content/readiness assertion.
    // Unconfigured keys intentionally follow the foreground at this step.
    let current=io.foreground()?;
    if current=="dev.vanzy.manager.demo"{return Err("Macro keys cannot target VANZY Manager".into())}
    if target_app.as_ref().is_some_and(|target|*target!=current){return Err(format!("Step {}: target application is not frontmost",index+1))}
    guard(cancel,deadline)?;io.chord(keys,*modifiers)?;
   },
   Step::Wait{ms}=>{let until=Instant::now()+Duration::from_millis(*ms);while Instant::now()<until{guard(cancel,deadline)?;std::thread::sleep(Duration::from_millis(10));}},
   Step::OpenApp{app,timeout_ms}=>{let previous=io.foreground()?;io.launch(&["-b",app],cancel,deadline)?;wait_frontmost(app,&previous,*timeout_ms,cancel,deadline,io)?;},
   Step::OpenUrl{url,app,timeout_ms}=>{let previous=io.foreground()?;io.launch(&["-b",app,url],cancel,deadline)?;wait_frontmost(app,&previous,*timeout_ms,cancel,deadline,io)?;},
  }
 }Ok(())
}

fn wait_frontmost(app:&str,previous:&str,timeout:u64,cancel:&AtomicBool,deadline:Instant,io:&mut impl Adapter)->Result<(),String>{let until=Instant::now()+Duration::from_millis(timeout);loop{guard(cancel,deadline)?;let current=io.foreground()?;if current==app{return Ok(())}if current!=previous{return Err("Unexpected foreground application while opening target".into())}if Instant::now()>=until{return Err("Target application did not become frontmost before timeout".into())}std::thread::sleep(Duration::from_millis(20));}}
fn open(args:&[&str],cancel:&AtomicBool,macro_deadline:Instant)->Result<(),String>{
 guard(cancel,macro_deadline)?;
 #[cfg(target_os="macos")] {let mut command=std::process::Command::new("/usr/bin/open");command.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());let mut child=command.spawn().map_err(|_|"Could not request OS application launch")?;let deadline=Instant::now()+Duration::from_secs(2);loop{if let Err(e)=guard(cancel,macro_deadline){let _=child.kill();let _=child.wait();return Err(e)}match child.try_wait(){Ok(Some(s))=>return if s.success(){Ok(())}else{Err("OS could not open target".into())},Ok(None)=>{},Err(_)=>return Err("OS launch status unavailable".into())}if Instant::now()>=deadline{let _=child.kill();let _=child.wait();return Err("OS launch request timed out".into())}std::thread::sleep(Duration::from_millis(10));}}
 #[cfg(not(target_os="macos"))] {let _=args;adapter_supported()}
}
#[cfg(target_os="macos")]
fn frontmost()->Result<String,String>{
 use std::ffi::{c_void,c_char,CStr};type Id=*mut c_void;
 #[link(name="AppKit",kind="framework")] extern "C" {}
 #[link(name="objc")] extern "C" {fn objc_getClass(n:*const c_char)->Id;fn sel_registerName(n:*const c_char)->Id;fn objc_msgSend();}
 unsafe {let msg:unsafe extern "C" fn(Id,Id)->Id=std::mem::transmute(objc_msgSend as *const ());
 let pool=msg(objc_getClass(b"NSAutoreleasePool\0".as_ptr().cast()),sel_registerName(b"new\0".as_ptr().cast()));
 let workspace=msg(objc_getClass(b"NSWorkspace\0".as_ptr().cast()),sel_registerName(b"sharedWorkspace\0".as_ptr().cast()));
 let app=msg(workspace,sel_registerName(b"frontmostApplication\0".as_ptr().cast()));
 let bundle=msg(app,sel_registerName(b"bundleIdentifier\0".as_ptr().cast()));
 let bytes=msg(bundle,sel_registerName(b"UTF8String\0".as_ptr().cast())) as *const c_char;
 let result=if bytes.is_null(){Err("Foreground application cannot be verified".into())}else{Ok(CStr::from_ptr(bytes).to_string_lossy().into_owned())};
 msg(pool,sel_registerName(b"drain\0".as_ptr().cast()));result}
}
#[cfg(not(target_os="macos"))]fn frontmost()->Result<String,String>{Err("Foreground verification unsupported".into())}
#[cfg(test)]mod tests{use super::*;fn m(steps:Vec<Step>)->Macro{Macro{version:1,steps}}
 #[test]fn rejects_limits(){assert!(validate(&m(vec![])).is_err());assert!(validate(&m(vec![Step::Wait{ms:10001}])).is_err());assert!(validate(&m(vec![Step::Wait{ms:5001},Step::Wait{ms:5000}])).is_err());assert!(validate(&m(vec![Step::Wait{ms:0};33])).is_err());}
 #[test]fn allows_url_keys_but_rejects_unsafe_urls(){for url in ["file:///tmp/a","javascript:alert(1)","https://user:password@example.org","https://example.org/\n"]{assert!(validate(&m(vec![Step::OpenUrl{url:url.into(),app:"org.example.App".into(),timeout_ms:1000}])).is_err())}assert!(validate(&m(vec![Step::OpenUrl{url:"https://example.org".into(),app:"org.example.App".into(),timeout_ms:1000},Step::Key{keys:vec![4],modifiers:0,target_app:None}])).is_ok());}
 #[test]fn cancellation_and_timeout(){assert!(guard(&AtomicBool::new(true),Instant::now()+Duration::from_secs(1)).is_err());assert!(guard(&AtomicBool::new(false),Instant::now()).is_err());}
}

#[cfg(test)]mod runner_tests {
 use super::*;
 struct Fake {app:String,events:Vec<String>,switch_on_launch:bool,reads:usize,steal_at:usize}
 impl Adapter for Fake {
  fn foreground(&mut self)->Result<String,String>{self.reads+=1;if self.reads==self.steal_at{self.app="other.app".into()}Ok(self.app.clone())}
  fn launch(&mut self,args:&[&str],cancel:&AtomicBool,deadline:Instant)->Result<(),String>{let _=(cancel,deadline);self.events.push("open".into());if self.switch_on_launch{self.app=args[1].into()}Ok(())}
  fn chord(&mut self,_:&[u16],_:u8)->Result<(),String>{self.events.push("key+release".into());Ok(())}
 }
 fn fake()->Fake{Fake{app:"initial.app".into(),events:vec![],switch_on_launch:true,reads:0,steal_at:usize::MAX}}
 fn key()->Step{Step::Key{keys:vec![4],modifiers:0,target_app:None}}
 #[test]fn sequential_keys_release_before_next_step(){let mut io=fake();let m=Macro{version:1,steps:vec![key(),Step::Wait{ms:0},Step::OpenApp{app:"target.app".into(),timeout_ms:100},key()]};assert!(run_with(&m,&AtomicBool::new(false),|_|{},&mut io).is_ok());assert_eq!(io.events,vec!["key+release","open","key+release"]);}
 #[test]fn optional_guard_rejects_mismatch(){let mut io=fake();let m=Macro{version:1,steps:vec![Step::Key{keys:vec![4],modifiers:0,target_app:Some("target.app".into())}]};assert!(run_with(&m,&AtomicBool::new(false),|_|{},&mut io).is_err());assert!(io.events.is_empty());}
 #[test]fn optional_guard_allows_match(){let mut io=fake();let m=Macro{version:1,steps:vec![Step::Key{keys:vec![4],modifiers:0,target_app:Some("initial.app".into())}]};assert!(run_with(&m,&AtomicBool::new(false),|_|{},&mut io).is_ok());assert_eq!(io.events,vec!["key+release"]);}
 #[test]fn ordinary_keys_follow_foreground(){let mut io=fake();io.steal_at=2;let m=Macro{version:1,steps:vec![key(),key()]};assert!(run_with(&m,&AtomicBool::new(false),|_|{},&mut io).is_ok());assert_eq!(io.events,vec!["key+release","key+release"]);}
 #[test]fn url_wait_then_key_allowed(){let mut io=fake();let m=Macro{version:1,steps:vec![Step::OpenUrl{url:"https://example.org".into(),app:"target.app".into(),timeout_ms:100},Step::Wait{ms:1},key()]};assert!(validate(&m).is_ok());assert!(run_with(&m,&AtomicBool::new(false),|_|{},&mut io).is_ok());assert_eq!(io.events,vec!["open","key+release"]);}
 #[test]fn manager_self_target_is_always_refused(){let mut io=fake();io.app="dev.vanzy.manager.demo".into();let m=Macro{version:1,steps:vec![key()]};assert!(run_with(&m,&AtomicBool::new(false),|_|{},&mut io).is_err());assert!(io.events.is_empty());}
 #[test]fn cancel_prevents_all_output(){let mut io=fake();let m=Macro{version:1,steps:vec![key()]};assert!(run_with(&m,&AtomicBool::new(true),|_|{},&mut io).is_err());assert!(io.events.is_empty());}
 #[test]fn timeout_does_not_send_next_key(){let mut io=fake();io.switch_on_launch=false;let m=Macro{version:1,steps:vec![Step::OpenApp{app:"target.app".into(),timeout_ms:1},key()]};assert!(run_with(&m,&AtomicBool::new(false),|_|{},&mut io).is_err());assert_eq!(io.events,vec!["open"]);}
 #[test]fn cancellation_during_wait_stops_next_key(){let mut io=fake();let cancel=AtomicBool::new(false);let m=Macro{version:1,steps:vec![Step::Wait{ms:100},key()]};assert!(run_with(&m,&cancel,|_|{cancel.store(true,Ordering::SeqCst)},&mut io).is_err());assert!(io.events.is_empty());}
}
