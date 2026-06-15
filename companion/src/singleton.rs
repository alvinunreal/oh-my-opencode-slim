use std::path::PathBuf;

fn lock_path(owner_session_id: &str) -> PathBuf {
    let safe_owner = owner_session_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
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
        .join(format!("companion.{safe_owner}.pid"))
}

/// Returns true if this process should continue running.
/// Returns false if another companion instance for the same OpenCode session is
/// already alive.
pub fn acquire(owner_session_id: &str) -> bool {
    let path = lock_path(owner_session_id);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    for _ in 0..2 {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                use std::io::Write;
                let _ = write!(file, "{}", std::process::id());
                crate::log::debug(format!(
                    "lock acquired owner_session_id={} pid={} path={}",
                    owner_session_id,
                    std::process::id(),
                    path.display()
                ));
                return true;
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing_pid = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|content| content.trim().parse::<u32>().ok());
                if existing_pid.is_some_and(|pid| pid != std::process::id() && is_alive(pid)) {
                    crate::log::debug(format!(
                        "lock duplicate owner_session_id={} existing_pid={:?} current_pid={}",
                        owner_session_id,
                        existing_pid,
                        std::process::id()
                    ));
                    return false;
                }
                crate::log::debug(format!(
                    "lock stale owner_session_id={} existing_pid={:?} current_pid={} path={}",
                    owner_session_id,
                    existing_pid,
                    std::process::id(),
                    path.display()
                ));
                let _ = std::fs::remove_file(&path);
            }
            Err(err) => {
                crate::log::debug(format!(
                    "lock error owner_session_id={} err={} path={}",
                    owner_session_id,
                    err,
                    path.display()
                ));
                return false;
            }
        }
    }

    false
}

#[cfg(unix)]
fn is_alive(pid: u32) -> bool {
    // kill -0 checks if the process exists without sending a signal
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(not(unix))]
fn is_alive(_pid: u32) -> bool {
    false
}
