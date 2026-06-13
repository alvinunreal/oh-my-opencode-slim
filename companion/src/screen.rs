/// Returns the primary screen's logical size.
pub fn primary_size() -> [f32; 2] {
    platform_size().unwrap_or([1440.0, 900.0])
}

#[cfg(target_os = "macos")]
fn platform_size() -> Option<[f32; 2]> {
    let out = std::process::Command::new("osascript")
        .args([
            "-e",
            "tell application \"Finder\" to get bounds of window of desktop",
        ])
        .output()
        .ok()?;
    let s = String::from_utf8(out.stdout).ok()?;
    let ns: Vec<f32> = s
        .trim()
        .split(", ")
        .filter_map(|p| p.parse().ok())
        .collect();
    (ns.len() == 4).then(|| [ns[2], ns[3]])
}

#[cfg(not(target_os = "macos"))]
fn platform_size() -> Option<[f32; 2]> {
    None
}
