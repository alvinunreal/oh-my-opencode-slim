use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Duration;

const MAX_WINDOW_POSITIONS: usize = 100;
const MAX_PRESET_REQUESTS: usize = 64;

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
pub struct SessionInfo {
    pub session_id: String,
    pub cwd: String,
    #[serde(default)]
    pub active_agents: Vec<String>,
    #[serde(default)]
    pub active_agent: Option<String>,
    #[serde(default)]
    pub status: String,
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

struct StateWriteLock {
    path: PathBuf,
}

impl StateWriteLock {
    fn acquire(state_path: &std::path::Path) -> std::io::Result<Self> {
        let lock_path = state_path.with_extension("json.lock");
        for _ in 0..40 {
            match std::fs::create_dir(&lock_path) {
                Ok(()) => return Ok(Self { path: lock_path }),
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(err) => return Err(err),
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            "timed out waiting for companion state lock",
        ))
    }
}

impl Drop for StateWriteLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.path);
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
    use super::{read_state, write_preset_request, CompanionPresetRequest};
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
