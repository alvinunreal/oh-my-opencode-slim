use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_WINDOW_POSITIONS: usize = 100;
const MAX_PRESET_REQUESTS: usize = 64;
const STATE_LOCK_RETRY_ATTEMPTS: usize = 40;
const STATE_LOCK_RETRY_MS: u64 = 25;
const STATE_LOCK_OWNERLESS_GRACE_MS: u64 = 5_000;
static STATE_LOCK_TOKEN_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanionConfigState {
    pub enabled: bool,
    pub position: String,
    pub size: String,
    #[serde(default = "default_gif_pack", rename = "gifPack")]
    pub gif_pack: String,
    #[serde(default = "default_loop_style", rename = "loopStyle")]
    pub loop_style: String,
    #[serde(default = "default_speed")]
    pub speed: f32,
}

fn default_gif_pack() -> String {
    "default".to_string()
}

fn default_loop_style() -> String {
    "classic".to_string()
}

fn default_speed() -> f32 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CompanionState {
    pub version: u32,
    #[serde(default)]
    pub sessions: Vec<SessionInfo>,
    #[serde(default)]
    pub config: Option<CompanionConfigState>,
    #[serde(default)]
    pub window_positions: BTreeMap<String, WindowPositionState>,
    #[serde(default)]
    pub preset_requests: Vec<CompanionPresetRequest>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct WindowPositionState {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanionPresetState {
    #[serde(default)]
    pub current: Option<String>,
    #[serde(default)]
    pub available: Vec<String>,
    #[serde(default)]
    pub effective: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub global: Option<String>,
    #[serde(default)]
    pub project_available: Vec<String>,
    #[serde(default)]
    pub global_available: Vec<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub last_request_id: Option<String>,
    #[serde(default)]
    pub result_ok: Option<bool>,
    #[serde(default)]
    pub last_scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanionPresetRequest {
    pub request_id: String,
    pub session_id: String,
    #[serde(default = "default_preset_scope")]
    pub scope: String,
    #[serde(default)]
    pub preset: Option<String>,
    #[serde(default)]
    pub inherit: bool,
}

fn default_preset_scope() -> String {
    "effective".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanionAgentDetail {
    pub session_id: String,
    pub agent: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub variant: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub cwd: String,
    #[serde(default)]
    pub active_agents: Vec<String>,
    #[serde(default)]
    pub active_agent_details: Vec<CompanionAgentDetail>,
    #[serde(default)]
    pub active_agent: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub attention_seq: u64,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub config: Option<CompanionConfigState>,
    #[serde(default)]
    pub preset: Option<CompanionPresetState>,
}

pub fn state_file_path() -> PathBuf {
    let base = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".local")
                .join("share")
        });
    base.join("opencode")
        .join("storage")
        .join("oh-my-opencode-slim")
        .join("companion-state.json")
}

pub fn read_state(path: &std::path::Path) -> CompanionState {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn write_preset_request(
    path: &std::path::Path,
    request: CompanionPresetRequest,
) -> std::io::Result<()> {
    let valid_scope =
        request.scope == "effective" || request.scope == "project" || request.scope == "global";
    let valid_selection = if request.inherit {
        request.scope == "project" && request.preset.is_none()
    } else {
        request
            .preset
            .as_deref()
            .map(str::trim)
            .is_some_and(|preset| !preset.is_empty())
    };
    if request.request_id.trim().is_empty()
        || request.session_id.trim().is_empty()
        || !valid_scope
        || !valid_selection
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid companion preset request",
        ));
    }

    let _lock = StateWriteLock::acquire(path)?;
    let mut state = read_state(path);

    // Drop orphaned requests whose target manager no longer has a published
    // session entry, then append without overwriting requests from other
    // Companion windows/processes.
    let live_sessions: std::collections::BTreeSet<&str> = state
        .sessions
        .iter()
        .map(|session| session.session_id.as_str())
        .collect();
    state
        .preset_requests
        .retain(|pending| live_sessions.contains(pending.session_id.as_str()));
    if state
        .preset_requests
        .iter()
        .any(|pending| pending.request_id == request.request_id)
    {
        return Ok(());
    }
    if state.preset_requests.len() >= MAX_PRESET_REQUESTS {
        return Err(std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            "companion preset request queue is full",
        ));
    }
    state.preset_requests.push(request);

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let json = serde_json::to_string(&state).map_err(std::io::Error::other)?;
    std::fs::write(&tmp, json)?;
    if let Err(err) = _lock.ensure_owned() {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    std::fs::rename(tmp, path)?;
    Ok(())
}

pub fn write_project_window_position(
    path: &std::path::Path,
    project: &str,
    position: WindowPositionState,
) -> std::io::Result<()> {
    if project.trim().is_empty() || !position.x.is_finite() || !position.y.is_finite() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid companion window position",
        ));
    }

    let _lock = StateWriteLock::acquire(path)?;
    let mut state = read_state(path);
    state.window_positions.insert(project.to_string(), position);
    prune_window_positions(&mut state.window_positions, project);

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let json = serde_json::to_string(&state).map_err(std::io::Error::other)?;
    std::fs::write(&tmp, json)?;
    if let Err(err) = _lock.ensure_owned() {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    std::fs::rename(tmp, path)?;
    Ok(())
}

fn prune_window_positions(
    positions: &mut BTreeMap<String, WindowPositionState>,
    protected_project: &str,
) {
    while positions.len() > MAX_WINDOW_POSITIONS {
        let Some(key) = positions
            .keys()
            .find(|key| key.as_str() != protected_project)
            .cloned()
        else {
            break;
        };
        positions.remove(&key);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StateLockSnapshot {
    owner: Option<Vec<u8>>,
    modified: Option<SystemTime>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LockRemoval {
    Removed,
    Restored,
    Gone,
}

struct StateWriteLock {
    path: PathBuf,
    token: String,
}

fn read_state_lock_snapshot(lock_path: &std::path::Path) -> StateLockSnapshot {
    StateLockSnapshot {
        owner: std::fs::read(lock_path.join("owner")).ok(),
        modified: std::fs::metadata(lock_path)
            .and_then(|metadata| metadata.modified())
            .ok(),
    }
}

fn parse_state_lock_owner(raw: &[u8]) -> Option<(u32, &str)> {
    let text = std::str::from_utf8(raw).ok()?;
    let mut lines = text.lines();
    let pid = lines.next()?.trim().parse::<u32>().ok()?;
    if pid == 0 {
        return None;
    }
    let token = lines.next()?.trim();
    if token.is_empty() {
        return None;
    }
    Some((pid, token))
}

#[cfg(unix)]
fn state_lock_pid_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn state_lock_pid_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_ACCESS_DENIED, INVALID_HANDLE_VALUE, STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    if pid == 0 {
        return false;
    }

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok == 0 || code == STILL_ACTIVE as u32
    }
}

#[cfg(not(any(unix, windows)))]
fn state_lock_pid_is_alive(_pid: u32) -> bool {
    true
}

fn state_lock_snapshot_is_live(snapshot: &StateLockSnapshot) -> bool {
    if let Some(owner) = snapshot.owner.as_deref() {
        if let Some((pid, _)) = parse_state_lock_owner(owner) {
            return state_lock_pid_is_alive(pid);
        }
    }

    snapshot
        .modified
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age < Duration::from_millis(STATE_LOCK_OWNERLESS_GRACE_MS))
}

fn next_state_lock_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let counter = STATE_LOCK_TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{nanos:x}-{counter:x}", std::process::id())
}

fn state_lock_claim_path(lock_path: &std::path::Path) -> PathBuf {
    let suffix = next_state_lock_token();
    let name = lock_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("companion-state.json.lock");
    lock_path.with_file_name(format!("{name}.claim-{suffix}"))
}

fn remove_state_lock_if_matches(
    lock_path: &std::path::Path,
    expected: &StateLockSnapshot,
) -> LockRemoval {
    let claim_path = state_lock_claim_path(lock_path);
    match std::fs::rename(lock_path, &claim_path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return LockRemoval::Gone,
        Err(_) => return LockRemoval::Restored,
    }

    let claimed = read_state_lock_snapshot(&claim_path);
    if &claimed != expected {
        if !lock_path.exists() {
            let _ = std::fs::rename(&claim_path, lock_path);
        }
        return LockRemoval::Restored;
    }

    let _ = std::fs::remove_dir_all(&claim_path);
    LockRemoval::Removed
}

impl StateWriteLock {
    fn acquire(state_path: &std::path::Path) -> std::io::Result<Self> {
        let lock_path = state_path.with_extension("json.lock");
        for _ in 0..STATE_LOCK_RETRY_ATTEMPTS {
            match std::fs::create_dir(&lock_path) {
                Ok(()) => {
                    let token = next_state_lock_token();
                    let owner = format!("{}\n{token}", std::process::id());
                    if let Err(err) = std::fs::write(lock_path.join("owner"), owner) {
                        let _ = std::fs::remove_dir_all(&lock_path);
                        return Err(err);
                    }
                    return Ok(Self {
                        path: lock_path,
                        token,
                    });
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                    let snapshot = read_state_lock_snapshot(&lock_path);
                    if !state_lock_snapshot_is_live(&snapshot) {
                        if remove_state_lock_if_matches(&lock_path, &snapshot)
                            == LockRemoval::Removed
                        {
                            continue;
                        }
                    }
                    std::thread::sleep(Duration::from_millis(STATE_LOCK_RETRY_MS));
                }
                Err(err) => return Err(err),
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            "timed out waiting for companion state lock",
        ))
    }

    fn ensure_owned(&self) -> std::io::Result<()> {
        let raw = std::fs::read(self.path.join("owner"))?;
        let owned = parse_state_lock_owner(&raw)
            .is_some_and(|(pid, token)| pid == std::process::id() && token == self.token);
        if owned {
            Ok(())
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::WouldBlock,
                "companion state lock ownership changed",
            ))
        }
    }
}

impl Drop for StateWriteLock {
    fn drop(&mut self) {
        let snapshot = read_state_lock_snapshot(&self.path);
        let owned = snapshot.owner.as_deref().is_some_and(|raw| {
            parse_state_lock_owner(raw)
                .is_some_and(|(pid, token)| pid == std::process::id() && token == self.token)
        });
        if owned {
            let _ = remove_state_lock_if_matches(&self.path, &snapshot);
        }
    }
}

/// Starts a background thread that polls the state file for changes.
/// Returns a receiver that fires whenever the file content changes.
pub fn start_watcher(path: PathBuf) -> Receiver<()> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || poll_loop(path, tx));
    rx
}

fn poll_loop(path: PathBuf, tx: Sender<()>) {
    let mut last_mtime: Option<std::time::SystemTime> = None;
    loop {
        if let Ok(meta) = std::fs::metadata(&path) {
            if let Ok(mtime) = meta.modified() {
                if Some(mtime) != last_mtime {
                    last_mtime = Some(mtime);
                    if tx.send(()).is_err() {
                        return;
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

#[cfg(test)]
mod tests {
    use super::{
        read_state, read_state_lock_snapshot, remove_state_lock_if_matches,
        state_lock_snapshot_is_live, write_preset_request, CompanionPresetRequest, LockRemoval,
        StateLockSnapshot, StateWriteLock,
    };
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_state_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!(
                "omos-companion-preset-state-{}-{label}-{nonce}",
                std::process::id()
            ))
            .join("companion-state.json")
    }

    #[test]
    fn live_owner_is_never_expired_by_lock_age() {
        let owner = format!("{}\nlive", std::process::id()).into_bytes();
        let snapshot = StateLockSnapshot {
            owner: Some(owner),
            modified: Some(UNIX_EPOCH),
        };
        assert!(state_lock_snapshot_is_live(&snapshot));
    }

    #[test]
    fn takeover_does_not_delete_a_successor_lock() {
        let state_path = temp_state_path("takeover-race");
        let lock_path = state_path.with_extension("json.lock");
        std::fs::create_dir_all(&lock_path).unwrap();
        std::fs::write(lock_path.join("owner"), b"999999999\nold").unwrap();
        let stale = read_state_lock_snapshot(&lock_path);

        std::fs::remove_dir_all(&lock_path).unwrap();
        std::fs::create_dir_all(&lock_path).unwrap();
        let successor = format!("{}\nsuccessor", std::process::id());
        std::fs::write(lock_path.join("owner"), &successor).unwrap();

        assert_eq!(
            remove_state_lock_if_matches(&lock_path, &stale),
            LockRemoval::Restored
        );
        assert_eq!(
            std::fs::read_to_string(lock_path.join("owner")).unwrap(),
            successor
        );
        let _ = std::fs::remove_dir_all(state_path.parent().unwrap());
    }

    #[test]
    fn release_does_not_delete_a_replaced_owner() {
        let state_path = temp_state_path("release-owner");
        std::fs::create_dir_all(state_path.parent().unwrap()).unwrap();
        let lock = StateWriteLock::acquire(&state_path).unwrap();
        let lock_path = state_path.with_extension("json.lock");
        let successor = format!("{}\nsuccessor", std::process::id());
        std::fs::write(lock_path.join("owner"), &successor).unwrap();

        drop(lock);

        assert_eq!(
            std::fs::read_to_string(lock_path.join("owner")).unwrap(),
            successor
        );
        let _ = std::fs::remove_dir_all(state_path.parent().unwrap());
    }

    #[test]
    fn old_preset_requests_default_to_effective_scope() {
        let path = temp_state_path("legacy-scope");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"version":1,"sessions":[{"session_id":"live","cwd":"/live"}],"preset_requests":[{"request_id":"old","session_id":"live","preset":"one"}]}"#,
        )
        .unwrap();

        let state = read_state(&path);
        assert_eq!(state.preset_requests.len(), 1);
        assert_eq!(state.preset_requests[0].scope, "effective");
        assert_eq!(state.preset_requests[0].preset.as_deref(), Some("one"));
        assert!(!state.preset_requests[0].inherit);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn preset_request_writer_accepts_project_inherit_action() {
        let path = temp_state_path("inherit");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"version":1,"sessions":[{"session_id":"live","cwd":"/live"}]}"#,
        )
        .unwrap();

        write_preset_request(
            &path,
            CompanionPresetRequest {
                request_id: "inherit".into(),
                session_id: "live".into(),
                scope: "project".into(),
                preset: None,
                inherit: true,
            },
        )
        .unwrap();

        let state = read_state(&path);
        assert_eq!(state.preset_requests.len(), 1);
        assert!(state.preset_requests[0].inherit);
        assert_eq!(state.preset_requests[0].scope, "project");
        assert!(state.preset_requests[0].preset.is_none());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn preset_request_writer_preserves_other_session_requests() {
        let path = temp_state_path("queue");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"version":1,"sessions":[{"session_id":"a","cwd":"/a"},{"session_id":"b","cwd":"/b"}]}"#,
        )
        .unwrap();

        write_preset_request(
            &path,
            CompanionPresetRequest {
                request_id: "req-a".into(),
                session_id: "a".into(),
                scope: "project".into(),
                preset: Some("one".into()),
                inherit: false,
            },
        )
        .unwrap();
        write_preset_request(
            &path,
            CompanionPresetRequest {
                request_id: "req-b".into(),
                session_id: "b".into(),
                scope: "global".into(),
                preset: Some("two".into()),
                inherit: false,
            },
        )
        .unwrap();

        let state = read_state(&path);
        assert_eq!(state.preset_requests.len(), 2);
        assert_eq!(state.preset_requests[0].request_id, "req-a");
        assert_eq!(state.preset_requests[1].request_id, "req-b");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn preset_request_writer_prunes_orphaned_requests() {
        let path = temp_state_path("orphan");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"version":1,"sessions":[{"session_id":"live","cwd":"/live"}],"preset_requests":[{"request_id":"old","session_id":"gone","preset":"one"}]}"#,
        )
        .unwrap();

        write_preset_request(
            &path,
            CompanionPresetRequest {
                request_id: "new".into(),
                session_id: "live".into(),
                scope: "project".into(),
                preset: Some("two".into()),
                inherit: false,
            },
        )
        .unwrap();

        let state = read_state(&path);
        assert_eq!(state.preset_requests.len(), 1);
        assert_eq!(state.preset_requests[0].request_id, "new");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
