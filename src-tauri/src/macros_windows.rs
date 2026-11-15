//! Windows macro adapter. No command interpreter, privilege escalation or focus-policy bypass.
use std::{path::Path, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::Duration, sync::mpsc, time::Instant};
use windows::{core::{w, BOOL, PCWSTR, PWSTR}, Win32::{
 Foundation::{CloseHandle, HANDLE, HWND, LPARAM},
 Storage::Packaging::Appx::GetApplicationUserModelId,
 System::{Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED}, Threading::{GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION}},
 UI::{Shell::{ApplicationActivationManager, IApplicationActivationManager, AO_NONE, ShellExecuteW, AssocQueryStringW, ASSOCF_IS_PROTOCOL, ASSOCSTR_APPID, ASSOCSTR_EXECUTABLE}, WindowsAndMessaging::{EnumWindows, GetForegroundWindow, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindowAsync, SW_RESTORE, SW_SHOWNORMAL}}
}};

pub fn valid(app: &str) -> bool {
 if let Some(id)=app.strip_prefix("aumid:") {return !id.is_empty() && id.len()<=255 && id.split('!').count()==2 && id.split('!').all(|p|!p.is_empty()) && id.bytes().all(|b|b.is_ascii_alphanumeric()||b"._!-".contains(&b));}
 let b=app.as_bytes();
 b.len()>=7 && b.len()<=32767 && b[0].is_ascii_alphabetic() && &b[1..3]==b":\\" && app.to_ascii_lowercase().ends_with(".exe")
 && !app[3..].chars().any(|c|c.is_control()||"/:<>\"|?*".contains(c))
 && app[3..].split('\\').all(|s|!s.is_empty()&&s!="."&&s!=".."&&!s.ends_with(' ')&&!s.ends_with('.'))
}
pub fn same(a:&str,b:&str)->bool {if a.starts_with("aumid:")||b.starts_with("aumid:"){a==b}else{a.eq_ignore_ascii_case(b)}}
fn wide(s:&str)->Vec<u16>{s.encode_utf16().chain(Some(0)).collect()}
struct Process(HANDLE);
impl Drop for Process {fn drop(&mut self){unsafe{let _=CloseHandle(self.0);}}}
fn identity(window:HWND)->Result<String,String>{
 if window.is_invalid(){return Err("No interactive foreground window is available".into())}
 unsafe {
  let mut pid=0;GetWindowThreadProcessId(window,Some(&mut pid));
  if pid==GetCurrentProcessId(){return Ok("dev.vanzy.manager.demo".into())}
  let p=Process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,false,pid).map_err(|_|"Foreground process identity unavailable")?);
  let mut id=vec![0u16;256];let mut len=id.len() as u32;
  if GetApplicationUserModelId(p.0,&mut len,Some(PWSTR(id.as_mut_ptr()))).0==0 && len>1 {
   return Ok(format!("aumid:{}",String::from_utf16_lossy(&id[..len as usize-1])));
  }
  let mut path=vec![0u16;32768];let mut len=path.len() as u32;
  QueryFullProcessImageNameW(p.0,PROCESS_NAME_WIN32,PWSTR(path.as_mut_ptr()),&mut len).map_err(|_|"Foreground executable identity unavailable")?;
  let path=String::from_utf16_lossy(&path[..len as usize]);
  if Path::new(&path).file_name().is_some_and(|n|n.to_string_lossy().eq_ignore_ascii_case("vanzy-manager.exe")){return Ok("dev.vanzy.manager.demo".into())}
  Ok(path)
 }
}
pub fn foreground()->Result<String,String>{identity(unsafe{GetForegroundWindow()})}
struct Search<'a>{target:&'a str,found:Option<HWND>}
unsafe extern "system" fn find(window:HWND,param:LPARAM)->BOOL{
 let search=&mut *(param.0 as *mut Search<'_>);
 if IsWindowVisible(window).as_bool() && identity(window).is_ok_and(|id|same(&id,search.target)) {search.found=Some(window);return BOOL(0)}BOOL(1)
}
fn activate_existing(target:&str,cancel:&AtomicBool,deadline:Instant)->Result<bool,String>{
 let mut search=Search{target,found:None};unsafe{let _=EnumWindows(Some(find),LPARAM((&mut search as *mut Search<'_>) as isize));}
 super::guard(cancel,deadline)?;
 if let Some(w)=search.found {unsafe{if IsIconic(w).as_bool(){let _=ShowWindowAsync(w,SW_RESTORE);}super::guard(cancel,deadline)?;let _=SetForegroundWindow(w);}Ok(true)}else{Ok(false)}
}
struct Com;
impl Com {fn init()->Result<Self,String>{unsafe{CoInitializeEx(None,COINIT_APARTMENTTHREADED).ok().map_err(|_|"Windows application activation unavailable")?;}Ok(Self)}}
impl Drop for Com {fn drop(&mut self){unsafe{CoUninitialize()}}}
// Refuse ambiguous/indirect associations rather than dispatching to an unrelated app.
// Registry association may still change after this check; OS dispatch cannot guarantee
// the destination view or its keyboard focus. No associations are modified.
fn verify_url_handler(url:&str,app:&str)->Result<(),String>{
 let parsed=tauri::Url::parse(url).map_err(|_|"Invalid URL")?;let scheme=wide(parsed.scheme());
 let kind=if app.starts_with("aumid:"){ASSOCSTR_APPID}else{ASSOCSTR_EXECUTABLE};
 let mut buffer=vec![0u16;32768];let mut len=buffer.len() as u32;
 let result=unsafe{AssocQueryStringW(ASSOCF_IS_PROTOCOL,kind,PCWSTR(scheme.as_ptr()),PCWSTR::null(),Some(PWSTR(buffer.as_mut_ptr())),&mut len)};
 if result.is_err()||len==0||len as usize>buffer.len(){return Err("URL handler identity cannot be verified; no URL was opened".into())}
 let raw=String::from_utf16_lossy(&buffer[..len as usize-1]);
 let actual=if app.starts_with("aumid:"){format!("aumid:{raw}")}else{raw};
 if !same(&actual,app){return Err("Registered URL handler differs from the configured application; no URL was opened".into())}Ok(())
}
static DISPATCH_BUSY:AtomicBool=AtomicBool::new(false);
pub fn available()->Result<(),String>{if DISPATCH_BUSY.load(Ordering::SeqCst){Err("Previous Windows OS request is still finishing; no new macro was started".into())}else{Ok(())}}
// OS activation/association calls are synchronous and cannot be forcibly cancelled.
// Isolate them so Stop/deadline stops this sequence promptly. Never detach a key
// sender. While a request finishes, refuse all new macros (no overlap or replay).
pub fn open(args:&[&str],cancel:&AtomicBool,deadline:Instant)->Result<(),String>{
 super::guard(cancel,deadline)?;
 let args:Vec<String>=args.iter().map(|s|s.to_string()).collect();
 dispatch(cancel,deadline,move|stop|{let refs:Vec<&str>=args.iter().map(String::as_str).collect();open_inner(&refs,stop,deadline)})
}
fn dispatch(cancel:&AtomicBool,deadline:Instant,operation:impl FnOnce(&AtomicBool)->Result<(),String>+Send+'static)->Result<(),String>{
 super::guard(cancel,deadline)?;
 if DISPATCH_BUSY.compare_exchange(false,true,Ordering::SeqCst,Ordering::SeqCst).is_err(){return Err("Previous Windows OS request is still finishing".into())}
 let stop=Arc::new(AtomicBool::new(false));let worker_stop=stop.clone();let (tx,rx)=mpsc::channel();
 let spawn=std::thread::Builder::new().name("macro-os-request".into()).spawn(move||{
  struct Release;impl Drop for Release{fn drop(&mut self){DISPATCH_BUSY.store(false,Ordering::SeqCst)}}let release=Release;
  let result=operation(&worker_stop);drop(release);let _=tx.send(result);
 });
 if spawn.is_err(){DISPATCH_BUSY.store(false,Ordering::SeqCst);return Err("Could not start Windows OS request".into())}
 loop{
  if let Err(e)=super::guard(cancel,deadline){stop.store(true,Ordering::SeqCst);return Err(format!("{e}; an already-dispatched OS request may still complete, but no later steps will run"))}
  match rx.recv_timeout(Duration::from_millis(10)){Ok(result)=>return result,Err(mpsc::RecvTimeoutError::Timeout)=>{},Err(_)=>return Err("Windows OS request ended unexpectedly".into())}
 }
}
fn open_inner(args:&[&str],cancel:&AtomicBool,deadline:Instant)->Result<(),String>{
 super::guard(cancel,deadline)?;
 let app=*args.get(1).ok_or("Missing target application")?;
 if !valid(app){return Err("Windows target requires an absolute EXE path or packaged aumid: identifier".into())}
 if let Some(url)=args.get(2) {
  // URL is a structured OS request. No command shell, executable parameters,
  // association changes or artificial focus transfer to the configured target.
  // Success means dispatch accepted; the shared runner separately observes foreground.
  verify_url_handler(url,app)?;
  super::guard(cancel,deadline)?;
  let value=wide(url);
  let result=unsafe{ShellExecuteW(None,w!("open"),PCWSTR(value.as_ptr()),PCWSTR::null(),PCWSTR::null(),SW_SHOWNORMAL)};
  if result.0 as isize<=32{return Err("Windows rejected the URL dispatch".into())}
 }else if !activate_existing(app,cancel,deadline)? {
  super::guard(cancel,deadline)?;
  if let Some(id)=app.strip_prefix("aumid:") {
   let _com=Com::init()?;let value=wide(id);
   let manager:IApplicationActivationManager=unsafe{CoCreateInstance(&ApplicationActivationManager,None,CLSCTX_LOCAL_SERVER)}.map_err(|_|"Windows packaged application activation unavailable")?;
   super::guard(cancel,deadline)?;
   unsafe{manager.ActivateApplication(PCWSTR(value.as_ptr()),PCWSTR::null(),AO_NONE)}.map_err(|_|"Windows could not activate the packaged application")?;
  }else{
   if !Path::new(app).is_file(){return Err("Configured application EXE is missing".into())}
   super::guard(cancel,deadline)?;
   let value=wide(app);
   let result=unsafe{ShellExecuteW(None,w!("open"),PCWSTR(value.as_ptr()),PCWSTR::null(),PCWSTR::null(),SW_SHOWNORMAL)};
   if result.0 as isize<=32{return Err("Windows rejected application launch".into())}
  }
 }
 // Never retry via AttachThreadInput, synthetic Alt, elevation, or focus-lock changes.
 super::guard(cancel,deadline)
}
#[cfg(test)] mod tests {
 use super::*;
 #[test]fn validates_native_identity_not_commands(){
  for a in [r"C:\Program Files\Example\App.exe","aumid:Example.App_abc!App"]{assert!(valid(a),"{a}")}
  for a in ["org.example.App",r"C:App.exe",r"\\server\share\App.exe",r"C:\..\App.exe",r"C:\App.exe --arg",r"C:\App.exe:stream",r"C:\bad\script.cmd","aumid:electron.app.Example",r"C:\bad.\App.exe"]{assert!(!valid(a),"{a}")}
 }
 #[test]fn dispatch_is_sequential_bounded_and_quarantines_late_completion(){
  let cancel=AtomicBool::new(false);
  for _ in 0..50 {assert!(dispatch(&cancel,Instant::now()+Duration::from_secs(1),|_|Ok(())).is_ok());}
  let (release_tx,release_rx)=mpsc::channel();
  assert!(dispatch(&cancel,Instant::now()+Duration::from_millis(30),move|_|{let _=release_rx.recv();Ok(())}).is_err());
  assert!(available().is_err());
  assert!(dispatch(&cancel,Instant::now()+Duration::from_secs(1),|_|panic!("must not replay")).is_err());
  release_tx.send(()).unwrap();let until=Instant::now()+Duration::from_secs(1);
  while available().is_err(){assert!(Instant::now()<until);std::thread::sleep(Duration::from_millis(1));}
  assert!(dispatch(&AtomicBool::new(true),Instant::now()+Duration::from_secs(1),|_|panic!("cancelled must not dispatch")).is_err());
  assert!(available().is_ok());
 }
 #[test]fn paths_case_insensitive_but_aumid_exact(){assert!(same(r"C:\APP.exe",r"c:\app.EXE"));assert!(!same("aumid:Example!App","aumid:example!App"));}
}
