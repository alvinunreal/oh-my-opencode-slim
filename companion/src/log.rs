use std::io::Write;
use std::path::PathBuf;

fn log_path() -> PathBuf {
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
    base.join("opencode").join("log").join(format!(
        "oh-my-opencode-slim-companion.{}.log",
        std::process::id()
    ))
}

pub fn debug(message: impl AsRef<str>) {
    if std::env::var("OH_MY_OPENCODE_SLIM_COMPANION_DEBUG")
        .ok()
        .as_deref()
        != Some("1")
    {
        return;
    }

    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{}", message.as_ref());
    }
}
