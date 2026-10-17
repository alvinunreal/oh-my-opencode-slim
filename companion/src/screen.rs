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

#[cfg(target_os = "windows")]
pub fn monitor_rects_physical() -> Option<Vec<[f32; 4]>> {
    use windows_sys::Win32::Foundation::{BOOL, LPARAM, RECT};
    use windows_sys::Win32::Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR};

    unsafe extern "system" fn collect(
        _monitor: HMONITOR,
        _hdc: HDC,
        rect: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        if rect.is_null() {
            return 0;
        }
        // EnumDisplayMonitors invokes this synchronously while the Vec lives.
        let monitors = unsafe { &mut *(data as *mut Vec<[f32; 4]>) };
        let rect = unsafe { &*rect };
        monitors.push([
            rect.left as f32,
            rect.top as f32,
            rect.right as f32,
            rect.bottom as f32,
        ]);
        1
    }

    let mut monitors: Vec<[f32; 4]> = Vec::new();
    let ok = unsafe {
        EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(collect),
            (&mut monitors as *mut Vec<[f32; 4]>) as LPARAM,
        )
    };
    (ok != 0 && !monitors.is_empty()).then_some(monitors)
}
