use std::sync::mpsc::Receiver;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;

use eframe::egui;

use crate::gifs::{AnimationFrame, Gifs};
use crate::niri;
use crate::screen::primary_size;
use crate::state::{
    read_state, start_watcher, write_preset_request, write_project_window_position,
    CompanionAgentDetail, CompanionConfigState, CompanionKnownProject, CompanionPresetRequest,
    CompanionPresetState, SessionInfo, WindowPositionState,
};

const DEFAULT_SIZE: f32 = 120.0;
const GAP: f32 = 10.0;

const SIZE_PRESETS: &[(&str, f32)] = &[("S", 80.0), ("M", 120.0), ("L", 160.0), ("XL", 200.0)];

const POPUP_W: f32 = 382.0;
const POPUP_H: f32 = 460.0;
const SURFACE_INSET: f32 = 1.0;

const SIZE_KEY: &str = "companion_size";
const MENU_OPEN_KEY: &str = "companion_menu_open";
const MENU_POS_KEY: &str = "companion_menu_pos";
const MENU_PROJECT_QUERY_KEY: &str = "companion_menu_project_query";
const MENU_SHOW_KNOWN_KEY: &str = "companion_menu_show_known";
const MENU_POPUP_FOCUSED_KEY: &str = "companion_menu_popup_focused";
const PRESET_SCOPE_GLOBAL_KEY: &str = "companion_preset_scope_global";
const PROJECT_OPEN_PENDING_KEY: &str = "companion_project_open_pending";
const PROJECT_OPEN_ERROR_KEY: &str = "companion_project_open_error";

#[derive(Clone, Debug, PartialEq, Eq)]
struct WindowGeometryKey {
    session_id: String,
    project_key: String,
    position: String,
    custom_x: Option<i32>,
    custom_y: Option<i32>,
    size_px: u32,
    cols: u32,
    rows: u32,
    screen_w: u32,
    screen_h: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ConfigKey {
    position: String,
    size: String,
    gif_pack: String,
    loop_style: String,
    speed_bits: u32,
}

fn should_apply_geometry(
    dragging: bool,
    applied: Option<&WindowGeometryKey>,
    next: &WindowGeometryKey,
) -> bool {
    !dragging && applied != Some(next)
}

fn grid_cols(n: usize) -> usize {
    match n {
        0 | 1 => 1,
        2 | 3 | 4 => 2,
        _ => 3,
    }
}

fn grid_dims(n: usize) -> (usize, usize) {
    let n = n.max(1);
    let cols = grid_cols(n);
    let rows = (n + cols - 1) / cols;
    (cols, rows)
}

fn size_from_config(size: &str) -> f32 {
    match size {
        "small" => 80.0,
        "medium" => 120.0,
        "large" => 160.0,
        "xl" | "xlarge" => 200.0,
        _ => DEFAULT_SIZE,
    }
}

fn config_key(config: Option<&CompanionConfigState>) -> Option<ConfigKey> {
    config.map(|cfg| ConfigKey {
        position: cfg.position.clone(),
        size: cfg.size.clone(),
        gif_pack: normalized_gif_pack(&cfg.gif_pack).to_string(),
        loop_style: normalized_loop_style(&cfg.loop_style).to_string(),
        speed_bits: normalized_speed(cfg.speed).to_bits(),
    })
}

fn config_for_owner<'a>(
    sessions: &'a [SessionInfo],
    owner_session_id: Option<&str>,
    global_config: Option<&'a CompanionConfigState>,
) -> Option<&'a CompanionConfigState> {
    owner_session_id
        .and_then(|owner| {
            sessions
                .iter()
                .find(|session| session.session_id == owner)
                .and_then(|session| session.config.as_ref())
        })
        .or(global_config)
}

fn normalized_gif_pack(pack: &str) -> &str {
    match pack {
        "default" => "default",
        _ => "default",
    }
}

fn normalized_loop_style(style: &str) -> &str {
    match style {
        "smooth" => "smooth",
        _ => "classic",
    }
}

fn normalized_speed(speed: f32) -> f32 {
    crate::gifs::normalized_speed(speed)
}

fn apply_config(
    key: Option<&ConfigKey>,
    position: &mut String,
    size: &mut f32,
    gif_pack: &mut String,
    loop_style: &mut String,
    speed: &mut f32,
) {
    if let Some(cfg) = key {
        *position = cfg.position.clone();
        *size = size_from_config(&cfg.size);
        *gif_pack = cfg.gif_pack.clone();
        *loop_style = cfg.loop_style.clone();
        *speed = f32::from_bits(cfg.speed_bits);
    } else {
        *position = "bottom-right".to_string();
        *size = DEFAULT_SIZE;
        *gif_pack = "default".to_string();
        *loop_style = "classic".to_string();
        *speed = normalized_speed(f32::NAN);
    }
}

fn window_size(cell: f32, cols: usize, rows: usize) -> [f32; 2] {
    [cell * cols as f32, cell * rows as f32]
}

fn handle_drag_start(
    ctx: &egui::Context,
    menu_open: bool,
    project_key: &str,
    drag_project_key: &mut Option<String>,
) {
    if !menu_open && ctx.input(|i| i.pointer.primary_pressed()) {
        *drag_project_key = Some(project_key.to_owned());
        ctx.send_viewport_cmd(egui::ViewportCommand::StartDrag);
    }
}

fn persist_window_position_async(
    state_path: std::path::PathBuf,
    project_key: String,
    position: WindowPositionState,
    generation: Arc<AtomicU64>,
    write_generation: u64,
) {
    std::thread::spawn(move || {
        for _ in 0..6 {
            if generation.load(Ordering::Acquire) != write_generation {
                return;
            }
            match write_project_window_position(&state_path, &project_key, position) {
                Ok(()) => return,
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(250));
                }
                Err(err) => {
                    crate::log::debug(format!(
                        "window position write failed project={project_key:?}: {err}"
                    ));
                    return;
                }
            }
        }
        crate::log::debug(format!(
            "window position write timed out project={project_key:?}"
        ));
    });
}

pub(crate) fn place_window(position: &str, screen: [f32; 2], win: [f32; 2]) -> [f32; 2] {
    let (screen_w, screen_h) = (screen[0], screen[1]);
    let (win_w, win_h) = (win[0], win[1]);
    let (x, y) = match position {
        "bottom-left" => (GAP, screen_h - win_h - GAP),
        "top-right" => (screen_w - win_w - GAP, GAP),
        "top-left" => (GAP, GAP),
        _ => (screen_w - win_w - GAP, screen_h - win_h - GAP),
    };
    let x_max = (screen_w - win_w - GAP).max(GAP);
    let y_max = (screen_h - win_h - GAP).max(GAP);
    [x.clamp(GAP, x_max), y.clamp(GAP, y_max)]
}

fn clamp_window_position(pos: [f32; 2], screen: [f32; 2], win: [f32; 2]) -> [f32; 2] {
    let x_max = (screen[0] - win[0] - GAP).max(GAP);
    let y_max = (screen[1] - win[1] - GAP).max(GAP);
    [pos[0].clamp(GAP, x_max), pos[1].clamp(GAP, y_max)]
}

fn restore_window_position(pos: [f32; 2], screen: [f32; 2], win: [f32; 2]) -> [f32; 2] {
    // egui 0.29 exposes monitor size but not monitor origin. If a saved native
    // position is outside origin-zero bounds, it may be on a secondary monitor
    // with a positive or negative origin. Preserve it instead of snapping it
    // back to the primary monitor.
    if 0.0 <= pos[0] && pos[0] < screen[0] && 0.0 <= pos[1] && pos[1] < screen[1] {
        clamp_window_position(pos, screen, win)
    } else {
        pos
    }
}

fn visible_on_monitor(
    position: [f32; 2],
    size: [f32; 2],
    native_pixels_per_point: f32,
    monitors: &[[f32; 4]],
) -> bool {
    if !position
        .iter()
        .chain(size.iter())
        .all(|value| value.is_finite())
        || !native_pixels_per_point.is_finite()
        || native_pixels_per_point <= 0.0
        || size[0] <= 0.0
        || size[1] <= 0.0
    {
        return false;
    }

    // egui viewport geometry is in logical points; Win32 EnumDisplayMonitors
    // returns physical virtual-desktop coordinates, including negative origins.
    let x = position[0] * native_pixels_per_point;
    let y = position[1] * native_pixels_per_point;
    let width = size[0] * native_pixels_per_point;
    let height = size[1] * native_pixels_per_point;
    let min_visible_w = width.min(48.0 * native_pixels_per_point);
    let min_visible_h = height.min(48.0 * native_pixels_per_point);

    monitors.iter().any(|rect| {
        let overlap_w = (x + width).min(rect[2]) - x.max(rect[0]);
        let overlap_h = (y + height).min(rect[3]) - y.max(rect[1]);
        overlap_w >= min_visible_w && overlap_h >= min_visible_h
    })
}

fn validated_saved_window_position(
    position: [f32; 2],
    screen: [f32; 2],
    size: [f32; 2],
    native_pixels_per_point: f32,
) -> Option<[f32; 2]> {
    if !position.iter().all(|value| value.is_finite()) {
        return None;
    }

    #[cfg(target_os = "windows")]
    {
        let monitors = crate::screen::monitor_rects_physical()?;
        let _ = screen;
        visible_on_monitor(position, size, native_pixels_per_point, &monitors).then_some(position)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = native_pixels_per_point;
        Some(restore_window_position(position, screen, size))
    }
}

fn stack_window_position(
    position: [f32; 2],
    anchor: &str,
    rank: usize,
    screen: [f32; 2],
    win: [f32; 2],
) -> [f32; 2] {
    let offset = (rank.min(8) as f32) * 18.0;
    let stacked = match anchor {
        "bottom-left" => [position[0] + offset, position[1] - offset],
        "top-right" => [position[0] - offset, position[1] + offset],
        "top-left" => [position[0] + offset, position[1] + offset],
        _ => [position[0] - offset, position[1] - offset],
    };
    clamp_window_position(stacked, screen, win)
}

fn canonical_project_key(cwd: &str) -> String {
    std::path::Path::new(cwd)
        .canonicalize()
        .ok()
        .and_then(|path| path.to_str().map(str::to_string))
        .unwrap_or_else(|| cwd.to_string())
}

fn agent_detail_tooltip(detail: &CompanionAgentDetail) -> String {
    let mut lines = vec![detail.agent.clone()];
    if let Some(model) = detail.model.as_deref() {
        lines.push(format!("Model: {model}"));
    }
    if let Some(variant) = detail.variant.as_deref() {
        lines.push(format!("Variant: {variant}"));
    }
    lines.join("\n")
}

fn attention_type_for_status(status: &str) -> Option<egui::UserAttentionType> {
    match status {
        "waiting-input" => Some(egui::UserAttentionType::Informational),
        _ => None,
    }
}

fn attention_key(session: &SessionInfo) -> Option<(String, u64)> {
    attention_type_for_status(&session.status)
        .map(|_| (session.session_id.clone(), session.attention_seq))
}

fn attention_stroke(status: &str) -> Option<egui::Stroke> {
    match status {
        "waiting-input" => Some(egui::Stroke::new(
            2.0,
            egui::Color32::from_rgb(245, 190, 75),
        )),
        _ => None,
    }
}

fn paint_outline(painter: &egui::Painter, rect: egui::Rect, stroke: egui::Stroke) {
    painter.line_segment([rect.left_top(), rect.right_top()], stroke);
    painter.line_segment([rect.right_top(), rect.right_bottom()], stroke);
    painter.line_segment([rect.right_bottom(), rect.left_bottom()], stroke);
    painter.line_segment([rect.left_bottom(), rect.left_top()], stroke);
}

fn cell_rects(agents: usize, cols: usize, rows: usize, cell: f32) -> Vec<egui::Rect> {
    let mut rects = Vec::with_capacity(agents);
    let full_rows = agents / cols;
    let remainder = agents % cols;

    for row in 0..full_rows {
        for col in 0..cols {
            rects.push(egui::Rect::from_min_size(
                egui::pos2(col as f32 * cell, row as f32 * cell),
                egui::vec2(cell, cell),
            ));
        }
    }

    if remainder > 0 {
        let x_offset = (cols - remainder) as f32 * cell / 2.0;
        for col in 0..remainder {
            rects.push(egui::Rect::from_min_size(
                egui::pos2(x_offset + col as f32 * cell, full_rows as f32 * cell),
                egui::vec2(cell, cell),
            ));
        }
    }

    let _ = rows;
    rects
}

fn choose_session(sessions: &[SessionInfo]) -> Option<usize> {
    sessions
        .iter()
        .enumerate()
        .rev()
        .find(|(_, s)| s.status == "waiting-input")
        .map(|(i, _)| i)
        .or_else(|| {
            sessions
                .iter()
                .enumerate()
                .rev()
                .find(|(_, s)| s.active_agents.iter().any(|agent| agent != "intro"))
                .map(|(i, _)| i)
        })
        .or_else(|| {
            sessions
                .iter()
                .enumerate()
                .rev()
                .find(|(_, s)| s.status == "busy")
                .map(|(i, _)| i)
        })
        .or_else(|| sessions.last().map(|_| sessions.len() - 1))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PresetScope {
    Project,
    Global,
}

impl PresetScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Global => "global",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PresetMenuAction {
    scope: PresetScope,
    preset: Option<String>,
    inherit: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum CompanionMenuAction {
    SelectProject(String),
    SelectKnownProject(String),
    SelectPreset(PresetMenuAction),
}

fn has_scoped_preset_state(state: &CompanionPresetState) -> bool {
    state.effective.is_some()
        || state.project.is_some()
        || state.global.is_some()
        || !state.project_available.is_empty()
        || !state.global_available.is_empty()
}

fn project_catalog(state: &CompanionPresetState) -> &[String] {
    if state.project_available.is_empty() && !has_scoped_preset_state(state) {
        &state.available
    } else {
        &state.project_available
    }
}

fn project_current(state: &CompanionPresetState) -> Option<&str> {
    if has_scoped_preset_state(state) {
        state.project.as_deref()
    } else {
        state.current.as_deref()
    }
}

fn preset_request_completed(sessions: &[SessionInfo], request_id: &str) -> bool {
    sessions.iter().any(|session| {
        session
            .preset
            .as_ref()
            .and_then(|preset| preset.last_request_id.as_deref())
            == Some(request_id)
    })
}

#[derive(Debug, PartialEq, Eq)]
struct PendingPresetRequest {
    request_id: String,
    session_id: String,
}

fn pending_preset_request_should_clear(
    sessions: &[SessionInfo],
    pending: &PendingPresetRequest,
) -> bool {
    preset_request_completed(sessions, &pending.request_id)
        || !sessions
            .iter()
            .any(|session| session.session_id == pending.session_id)
}

fn selected_session_index(
    sessions: &[SessionInfo],
    pinned_session_id: Option<&str>,
) -> Option<usize> {
    pinned_session_id
        .and_then(|session_id| {
            sessions
                .iter()
                .position(|session| session.session_id == session_id)
        })
        .or_else(|| choose_session(sessions))
}

fn preset_target_session_index(
    sessions: &[SessionInfo],
    preset_target_id: Option<&str>,
    displayed_idx: usize,
) -> Option<usize> {
    // An explicitly selected editor session that has disappeared must stay
    // unavailable. Never silently target the displayed (different) project.
    match preset_target_id {
        Some(session_id) => sessions
            .iter()
            .position(|entry| entry.session_id == session_id),
        None => Some(displayed_idx),
    }
}

fn session_activity_rank(session: &SessionInfo) -> u8 {
    if session.status == "waiting-input" {
        3
    } else if session.active_agents.iter().any(|agent| agent != "intro") {
        2
    } else if session.status == "busy" {
        1
    } else {
        0
    }
}

fn project_session_indices(sessions: &[SessionInfo]) -> Vec<usize> {
    let mut indices: Vec<usize> = Vec::new();
    for (index, session) in sessions.iter().enumerate() {
        if let Some(existing) = indices
            .iter_mut()
            .find(|existing| sessions[**existing].cwd == session.cwd)
        {
            // Prefer an active/waiting session over the last idle publisher.
            // For equal priority keep the newest session for current state.
            if session_activity_rank(session) >= session_activity_rank(&sessions[*existing]) {
                *existing = index;
            }
        } else {
            indices.push(index);
        }
    }
    indices
}

fn project_display_name(cwd: &str) -> String {
    std::path::Path::new(cwd)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(cwd)
        .to_string()
}

pub struct CompanionApp {
    state_path: std::path::PathBuf,
    owner_session_id: Option<String>,
    sessions: Vec<SessionInfo>,
    known_projects: Vec<CompanionKnownProject>,
    gifs: Gifs,
    rx: Receiver<()>,
    registered: bool,
    size: f32,
    gif_pack: String,
    loop_style: String,
    speed: f32,
    screen: [f32; 2],
    position: String,
    has_modern_config: bool,
    applied_config: Option<ConfigKey>,
    applied_geometry: Option<WindowGeometryKey>,
    last_logged_selection: Option<String>,
    window_positions: std::collections::BTreeMap<String, WindowPositionState>,
    project_keys: std::collections::BTreeMap<String, String>,
    drag_project_key: Option<String>,
    menu_target_session_id: Option<String>,
    preset_target_session_id: Option<String>,
    preset_target_cwd: Option<String>,
    menu_known_target_cwd: Option<String>,
    last_attention_key: Option<(String, u64)>,
    preset_request_seq: u64,
    position_write_generation: Arc<AtomicU64>,
    pending_window_positions: std::collections::BTreeMap<String, (WindowPositionState, u64)>,
    pending_preset_request: Option<PendingPresetRequest>,
    niri_generation: Arc<AtomicU64>,
}

impl CompanionApp {
    pub fn new(_cc: &eframe::CreationContext<'_>) -> Self {
        let state_path = crate::state::state_file_path();
        let owner_session_id = std::env::var("OH_MY_OPENCODE_SLIM_COMPANION_SESSION_ID")
            .ok()
            .filter(|session_id| !session_id.trim().is_empty());
        let state = read_state(&state_path);
        crate::log::debug(format!(
            "app new owner={:?} initial_sessions={}",
            owner_session_id,
            state.sessions.len()
        ));
        let sessions = state.sessions;
        let known_projects = state.known_projects;
        let window_positions = state.window_positions;

        let mut initial_size = DEFAULT_SIZE;
        let mut position = "bottom-right".to_string();
        let mut gif_pack = "default".to_string();
        let mut loop_style = "classic".to_string();
        let mut speed = normalized_speed(f32::NAN);
        let has_modern_config = state.config.is_some();
        let applied_config = config_key(config_for_owner(
            &sessions,
            owner_session_id.as_deref(),
            state.config.as_ref(),
        ));
        apply_config(
            applied_config.as_ref(),
            &mut position,
            &mut initial_size,
            &mut gif_pack,
            &mut loop_style,
            &mut speed,
        );

        let rx = start_watcher(state_path.clone());

        Self {
            state_path,
            owner_session_id,
            sessions,
            known_projects,
            gifs: Gifs::new(),
            rx,
            registered: false,
            size: initial_size,
            gif_pack,
            loop_style,
            speed,
            screen: primary_size(),
            position,
            has_modern_config,
            applied_config,
            applied_geometry: None,
            last_logged_selection: None,
            window_positions,
            project_keys: std::collections::BTreeMap::new(),
            drag_project_key: None,
            menu_target_session_id: None,
            preset_target_session_id: None,
            preset_target_cwd: None,
            menu_known_target_cwd: None,
            last_attention_key: None,
            preset_request_seq: 0,
            position_write_generation: Arc::new(AtomicU64::new(0)),
            pending_window_positions: std::collections::BTreeMap::new(),
            pending_preset_request: None,
            niri_generation: Arc::new(AtomicU64::new(0)),
        }
    }

    fn poll(&mut self) -> bool {
        if self.rx.try_recv().is_ok() {
            while self.rx.try_recv().is_ok() {}
            let state = read_state(&self.state_path);
            let clear_pending = self
                .pending_preset_request
                .as_ref()
                .map(|pending| pending_preset_request_should_clear(&state.sessions, pending))
                .unwrap_or(false);
            if clear_pending {
                self.pending_preset_request = None;
            }
            self.sessions = state.sessions;
            self.known_projects = state.known_projects;
            let owned_config = config_for_owner(
                &self.sessions,
                self.owner_session_id.as_deref(),
                state.config.as_ref(),
            );
            crate::log::debug(format!(
                "state update owner={:?} sessions={} global_config={:?} owned_config={:?}",
                self.owner_session_id,
                self.sessions.len(),
                state.config,
                owned_config
            ));
            let mut next_window_positions = state.window_positions;
            self.pending_window_positions
                .retain(|project, (pending_position, _generation)| {
                    if next_window_positions.get(project) == Some(pending_position) {
                        false
                    } else {
                        next_window_positions.insert(project.clone(), *pending_position);
                        true
                    }
                });
            self.window_positions = next_window_positions;
            self.project_keys
                .retain(|cwd, _| self.sessions.iter().any(|session| &session.cwd == cwd));
            self.has_modern_config = state.config.is_some();
            let next_config = config_key(owned_config);
            let config_changed = self.applied_config != next_config;
            if config_changed {
                apply_config(
                    next_config.as_ref(),
                    &mut self.position,
                    &mut self.size,
                    &mut self.gif_pack,
                    &mut self.loop_style,
                    &mut self.speed,
                );
                self.applied_config = next_config;
            }
            return config_changed;
        }

        let has_modern = self.has_modern_config;
        self.sessions
            .retain(|s| s.pid.map(is_pid_alive).unwrap_or(!has_modern));
        let clear_pending = self
            .pending_preset_request
            .as_ref()
            .map(|pending| pending_preset_request_should_clear(&self.sessions, pending))
            .unwrap_or(false);
        if clear_pending {
            self.pending_preset_request = None;
        }
        false
    }

    fn update_screen_from_ctx(&mut self, ctx: &egui::Context) {
        if let Some(size) = ctx.input(|i| i.viewport().monitor_size) {
            if 1.0 < size.x && 1.0 < size.y {
                self.screen = [size.x, size.y];
            }
        }
    }

    fn project_key_for(&mut self, cwd: &str) -> String {
        if let Some(key) = self.project_keys.get(cwd) {
            return key.clone();
        }
        let key = canonical_project_key(cwd);
        self.project_keys.insert(cwd.to_string(), key.clone());
        key
    }
}

impl eframe::App for CompanionApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        let config_changed = self.poll();
        self.update_screen_from_ctx(ctx);

        let quit = ctx.data(|d| {
            d.get_temp::<bool>(egui::Id::new("companion_quit"))
                .unwrap_or(false)
        });
        if quit || (self.registered && self.sessions.is_empty()) {
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            return;
        }

        if !self.registered {
            ctx.data_mut(|d| d.insert_temp(egui::Id::new(SIZE_KEY), self.size));
            self.registered = true;
        } else if config_changed {
            // Config/state changes are the source of truth. A right-click picker
            // selection remains local until the config tuple changes.
            ctx.data_mut(|d| d.insert_temp(egui::Id::new(SIZE_KEY), self.size));
        }

        self.size = ctx.data(|d| d.get_temp(egui::Id::new(SIZE_KEY)).unwrap_or(self.size));

        let menu_open = ctx.data(|d| {
            d.get_temp::<bool>(egui::Id::new(MENU_OPEN_KEY))
                .unwrap_or(false)
        });
        if !menu_open {
            self.menu_target_session_id = None;
            self.preset_target_session_id = None;
            self.preset_target_cwd = None;
            self.menu_known_target_cwd = None;
        }
        let pinned_session = if menu_open {
            self.menu_target_session_id.as_deref()
        } else {
            None
        };

        let Some(selected_idx) = selected_session_index(&self.sessions, pinned_session) else {
            egui::CentralPanel::default()
                .frame(egui::Frame::none().fill(egui::Color32::BLACK))
                .show(ctx, |ui| {
                    ui.centered_and_justified(|ui| {
                        ui.label("No active sessions");
                    });
                });
            ctx.request_repaint_after(Duration::from_millis(150));
            return;
        };

        let session = self.sessions[selected_idx].clone();
        // A menu's editing target must never replace the displayed animation
        // session. Keeping the display pinned also prevents background activity
        // from stealing the visible session while the user edits presets.
        let preset_target_idx = preset_target_session_index(
            &self.sessions,
            self.preset_target_session_id.as_deref(),
            selected_idx,
        );
        let mut preset_target = self.sessions[preset_target_idx.unwrap_or(selected_idx)].clone();
        if preset_target_idx.is_none() {
            // Preserve the selected project identity for diagnostics and
            // actions, but disable preset writes until it is selected again.
            preset_target.session_id = self.preset_target_session_id.clone().unwrap_or_default();
            preset_target.cwd = self.preset_target_cwd.clone().unwrap_or_default();
            preset_target.preset = None;
            preset_target.status = "unavailable".to_string();
        }
        if let Some(cwd) = self.menu_known_target_cwd.as_deref() {
            if let Some(known) = self.known_projects.iter().find(|known| known.cwd == cwd) {
                // A remembered project has no running manager; route its action
                // via the currently displayed live manager without displaying it.
                preset_target.session_id = session.session_id.clone();
                preset_target.cwd = known.cwd.clone();
                preset_target.preset = known.preset.clone();
                preset_target.status = "offline".to_string();
            } else {
                // A remembered target can be evicted while the popup is open.
                // Preserve its name and block editing; never silently fall
                // back to the old live target or the displayed session.
                preset_target.cwd = cwd.to_string();
                preset_target.preset = None;
                preset_target.status = "unavailable".to_string();
            }
        }
        if let Some(next_attention_key) = attention_key(&session) {
            if self.last_attention_key.as_ref() != Some(&next_attention_key) {
                if let Some(attention) = attention_type_for_status(&session.status) {
                    ctx.send_viewport_cmd(egui::ViewportCommand::RequestUserAttention(attention));
                }
                self.last_attention_key = Some(next_attention_key);
            }
        } else if self.last_attention_key.take().is_some() {
            ctx.send_viewport_cmd(egui::ViewportCommand::RequestUserAttention(
                egui::UserAttentionType::Reset,
            ));
        }

        let selection_log_key = format!(
            "{}|{}|{}|{:?}",
            session.session_id, session.cwd, session.status, session.active_agents
        );
        if self.last_logged_selection.as_ref() != Some(&selection_log_key) {
            crate::log::debug(format!(
                "selected owner={:?} idx={} session_id={} cwd={} status={} agents={:?}",
                self.owner_session_id,
                selected_idx,
                session.session_id,
                session.cwd,
                session.status,
                session.active_agents
            ));
            self.last_logged_selection = Some(selection_log_key);
        }
        let project_key = self.project_key_for(&session.cwd);
        let saved_position = self.window_positions.get(&project_key).copied();
        let pixels_per_point = ctx
            .input(|input| input.viewport().native_pixels_per_point)
            .unwrap_or(1.0);
        let time_seconds = ctx.input(|input| input.time);
        let agent_frames: Vec<(usize, AnimationFrame)> = if session.active_agents.is_empty() {
            self.gifs
                .frame(
                    ctx,
                    "intro",
                    &self.gif_pack,
                    self.speed,
                    &self.loop_style,
                    time_seconds,
                )
                .into_iter()
                .map(|frame| (usize::MAX, frame))
                .collect()
        } else {
            session
                .active_agents
                .iter()
                .enumerate()
                .filter_map(|(source_index, agent)| {
                    self.gifs
                        .frame(
                            ctx,
                            agent,
                            &self.gif_pack,
                            self.speed,
                            &self.loop_style,
                            time_seconds,
                        )
                        .map(|frame| (source_index, frame))
                })
                .collect()
        };
        let n = agent_frames.len().max(1);
        let (cols, rows) = grid_dims(n);
        let [win_w, win_h] = window_size(self.size, cols, rows);
        let geometry = WindowGeometryKey {
            session_id: session.session_id.clone(),
            project_key: project_key.clone(),
            position: self.position.clone(),
            custom_x: saved_position.map(|pos| pos.x.round() as i32),
            custom_y: saved_position.map(|pos| pos.y.round() as i32),
            size_px: self.size.round() as u32,
            cols: cols as u32,
            rows: rows as u32,
            screen_w: self.screen[0].round() as u32,
            screen_h: self.screen[1].round() as u32,
        };
        // Never re-apply native window geometry while the user is dragging.
        // Crossing onto a monitor with a different logical size changes
        // viewport().monitor_size; treating that as a geometry change during
        // StartDrag can emit OuterPosition and snap the window back.
        if should_apply_geometry(
            self.drag_project_key.is_some(),
            self.applied_geometry.as_ref(),
            &geometry,
        ) {
            ctx.send_viewport_cmd(egui::ViewportCommand::InnerSize(egui::vec2(win_w, win_h)));
            let validated_position = saved_position.and_then(|pos| {
                validated_saved_window_position(
                    [pos.x, pos.y],
                    self.screen,
                    [win_w, win_h],
                    pixels_per_point,
                )
            });
            if saved_position.is_some() && validated_position.is_none() {
                crate::log::debug(format!(
                    "invalid/off-screen saved geometry for project={project_key:?}; using visible anchor"
                ));
            }
            let pos = validated_position.unwrap_or_else(|| {
                stack_window_position(
                    place_window(&self.position, self.screen, [win_w, win_h]),
                    &self.position,
                    selected_idx,
                    self.screen,
                    [win_w, win_h],
                )
            });
            crate::log::debug(format!(
                "geometry owner={:?} session_id={} saved_position={:?} pos={:?} win=({}, {}) screen={:?} selected_idx={}",
                self.owner_session_id,
                session.session_id,
                saved_position,
                pos,
                win_w,
                win_h,
                self.screen,
                selected_idx
            ));
            ctx.send_viewport_cmd(egui::ViewportCommand::OuterPosition(egui::pos2(
                pos[0], pos[1],
            )));
            self.applied_geometry = Some(geometry);
            self.spawn_niri_fallback([win_w, win_h], saved_position);
        }

        handle_drag_start(ctx, menu_open, &project_key, &mut self.drag_project_key);
        if ctx.input(|i| i.pointer.primary_released()) {
            if let Some(project_key) = self.drag_project_key.take() {
                if let Some(rect) = ctx.input(|i| i.viewport().outer_rect) {
                    let position = WindowPositionState {
                        x: rect.min.x,
                        y: rect.min.y,
                    };
                    let write_generation = self
                        .position_write_generation
                        .fetch_add(1, Ordering::AcqRel)
                        + 1;
                    self.window_positions.insert(project_key.clone(), position);
                    self.pending_window_positions
                        .insert(project_key.clone(), (position, write_generation));
                    self.applied_geometry = None;
                    persist_window_position_async(
                        self.state_path.clone(),
                        project_key,
                        position,
                        Arc::clone(&self.position_write_generation),
                        write_generation,
                    );
                }
            }
        }

        if ctx.input(|i| i.pointer.secondary_released()) {
            let cursor = ctx.input(|i| i.pointer.interact_pos()).unwrap_or_default();
            self.menu_target_session_id = Some(session.session_id.clone());
            self.preset_target_session_id = Some(session.session_id.clone());
            self.preset_target_cwd = Some(session.cwd.clone());
            self.menu_known_target_cwd = None;
            ctx.data_mut(|d| {
                d.insert_temp(egui::Id::new(MENU_POS_KEY), [cursor.x, cursor.y]);
                d.insert_temp(egui::Id::new(MENU_OPEN_KEY), true);
                d.insert_temp(egui::Id::new(MENU_POPUP_FOCUSED_KEY), false);
            });
        }

        egui::CentralPanel::default()
            .frame(
                egui::Frame::none()
                    .fill(egui::Color32::TRANSPARENT)
                    .inner_margin(egui::Margin::ZERO),
            )
            .show(ctx, |ui| {
                ui.spacing_mut().item_spacing = egui::Vec2::ZERO;
                render_session(ui, ctx, &session, &agent_frames, self.size, win_w, win_h);
            });

        if let Some(action) = render_companion_menu(
            ctx,
            &self.sessions,
            &self.known_projects,
            &preset_target,
            self.pending_preset_request.is_some(),
        ) {
            match action {
                CompanionMenuAction::SelectProject(session_id) => {
                    if self.sessions.iter().any(|s| s.session_id == session_id) {
                        self.preset_target_cwd = self
                            .sessions
                            .iter()
                            .find(|entry| entry.session_id == session_id)
                            .map(|entry| entry.cwd.clone());
                        self.preset_target_session_id = Some(session_id);
                        self.menu_known_target_cwd = None;
                    }
                }
                CompanionMenuAction::SelectKnownProject(cwd) => {
                    if self.known_projects.iter().any(|known| known.cwd == cwd) {
                        self.menu_known_target_cwd = Some(cwd);
                    }
                }
                CompanionMenuAction::SelectPreset(action) => {
                    if preset_target.status == "unavailable" {
                        crate::log::debug("preset request ignored: selected project exited");
                        return;
                    }
                    self.preset_request_seq = self.preset_request_seq.wrapping_add(1);
                    let request_id = format!("{}-{}", std::process::id(), self.preset_request_seq);
                    let request = CompanionPresetRequest {
                        request_id: request_id.clone(),
                        session_id: preset_target.session_id.clone(),
                        target_cwd: self.menu_known_target_cwd.clone(),
                        scope: action.scope.as_str().to_string(),
                        preset: action.preset,
                        inherit: action.inherit,
                    };
                    match write_preset_request(&self.state_path, request) {
                        Ok(()) => {
                            self.pending_preset_request = Some(PendingPresetRequest {
                                request_id,
                                session_id: preset_target.session_id.clone(),
                            });
                        }
                        Err(err) => {
                            crate::log::debug(format!("preset request write failed: {err}"));
                        }
                    }
                }
            }
        }
        ctx.request_repaint_after(Duration::from_millis(16));
    }
}

impl CompanionApp {
    fn spawn_niri_fallback(&self, win_size: [f32; 2], saved_position: Option<WindowPositionState>) {
        let socket = match std::env::var("NIRI_SOCKET") {
            Ok(socket) if !socket.is_empty() => socket,
            _ => return,
        };
        let desired = saved_position
            .map(|pos| restore_window_position([pos.x, pos.y], self.screen, win_size))
            .unwrap_or_else(|| place_window(&self.position, self.screen, win_size));
        if !desired[0].is_finite() || !desired[1].is_finite() {
            return;
        }
        let generation = self.niri_generation.fetch_add(1, Ordering::Relaxed) + 1;
        let position = self.position.clone();
        let target_position = saved_position.map(|pos| [pos.x, pos.y]);
        let screen = self.screen;
        let niri_generation = Arc::clone(&self.niri_generation);
        std::thread::spawn(move || {
            niri::retry_move_current_window(
                socket,
                std::process::id(),
                generation,
                niri_generation,
                position,
                target_position,
                screen,
                win_size,
            );
        });
    }
}

fn render_session(
    ui: &mut egui::Ui,
    ctx: &egui::Context,
    session: &SessionInfo,
    agent_frames: &[(usize, AnimationFrame)],
    current_size: f32,
    win_w: f32,
    win_h: f32,
) {
    let cwd = &session.cwd;

    let project = std::path::Path::new(&cwd)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let n = agent_frames.len().max(1);
    let (cols, rows) = grid_dims(n);
    let rects = cell_rects(n, cols, rows, current_size);

    let surface = egui::Rect::from_min_max(
        egui::pos2(SURFACE_INSET, SURFACE_INSET),
        egui::pos2(win_w - SURFACE_INSET, win_h - SURFACE_INSET),
    );
    ui.painter().rect_filled(surface, 0.0, egui::Color32::BLACK);

    for (i, (source_index, frame)) in agent_frames.iter().enumerate() {
        if let Some(&cell) = rects.get(i) {
            ui.painter().image(
                frame.texture_id,
                cell.shrink(SURFACE_INSET),
                frame.uv,
                egui::Color32::WHITE,
            );

            if let Some(detail) = session.active_agent_details.get(*source_index) {
                ui.interact(
                    cell,
                    egui::Id::new(("companion-agent-detail", &session.session_id, source_index)),
                    egui::Sense::hover(),
                )
                .on_hover_text(agent_detail_tooltip(detail));
            }
        }
    }

    let label_h = (current_size * 0.15).clamp(13.0, 30.0);
    let font_size = (current_size * 0.09).clamp(9.0, 13.0);
    let strip = egui::Rect::from_min_size(
        egui::pos2(SURFACE_INSET, win_h - label_h - SURFACE_INSET),
        egui::vec2(win_w - SURFACE_INSET * 2.0, label_h),
    );
    ui.painter()
        .rect_filled(strip, 0.0, egui::Color32::from_black_alpha(185));

    let fid = egui::FontId::proportional(font_size);
    let max_text_w = win_w - 10.0;
    let label = fit_text(ctx, &project, &fid, max_text_w);
    ui.painter().text(
        strip.center(),
        egui::Align2::CENTER_CENTER,
        &label,
        fid,
        egui::Color32::WHITE,
    );

    if let Some(stroke) = attention_stroke(&session.status) {
        paint_outline(ui.painter(), surface.shrink(1.0), stroke);
    }
}

fn open_project_directory(path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let status = std::process::Command::new("explorer.exe")
            .arg(path)
            .status()
            .map_err(|err| err.to_string())?;
        return if status.success() {
            Ok(())
        } else {
            Err(format!("file manager exited with {status}"))
        };
    }

    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg(path)
            .status()
            .map_err(|err| err.to_string())?;
        return if status.success() {
            Ok(())
        } else {
            Err(format!("file manager exited with {status}"))
        };
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let status = std::process::Command::new("xdg-open")
            .arg(path)
            .status()
            .map_err(|err| err.to_string())?;
        return if status.success() {
            Ok(())
        } else {
            Err(format!("file manager exited with {status}"))
        };
    }

    #[allow(unreachable_code)]
    Err("opening project folders is not supported on this platform".to_string())
}

fn project_open_pending_id(session_id: &str) -> egui::Id {
    egui::Id::new((PROJECT_OPEN_PENDING_KEY, session_id))
}

fn project_open_error_id(session_id: &str) -> egui::Id {
    egui::Id::new((PROJECT_OPEN_ERROR_KEY, session_id))
}

fn start_project_directory_open(ctx: &egui::Context, session_id: &str, path: &str) {
    let pending_id = project_open_pending_id(session_id);
    let error_id = project_open_error_id(session_id);
    ctx.data_mut(|d| {
        d.insert_temp(pending_id, true);
        d.insert_temp(error_id, String::new());
    });

    let ctx_for_thread = ctx.clone();
    let path = path.to_string();
    let worker_path = path.clone();
    let spawn_result = std::thread::Builder::new()
        .name("companion-project-open".to_string())
        .spawn(move || {
            let result = open_project_directory(&worker_path);
            if let Err(err) = &result {
                crate::log::debug(format!(
                    "open project folder failed path={worker_path:?}: {err}"
                ));
            }
            ctx_for_thread.data_mut(|d| {
                d.insert_temp(pending_id, false);
                d.insert_temp(
                    error_id,
                    result
                        .err()
                        .map(|err| format!("Open failed: {err}"))
                        .unwrap_or_default(),
                );
            });
            ctx_for_thread.request_repaint();
        });

    if let Err(err) = spawn_result {
        crate::log::debug(format!(
            "open project folder worker failed path={path:?}: {err}"
        ));
        ctx.data_mut(|d| {
            d.insert_temp(pending_id, false);
            d.insert_temp(error_id, format!("Open failed: {err}"));
        });
    }
}

fn popup_position_for_monitors(
    pointer: [f32; 2],
    popup: [f32; 2],
    points_to_pixels: f32,
    monitors: &[[f32; 4]],
) -> [f32; 2] {
    if !pointer
        .iter()
        .chain(popup.iter())
        .all(|coordinate| coordinate.is_finite())
        || !points_to_pixels.is_finite()
        || points_to_pixels <= 0.0
    {
        return pointer;
    }

    let p = [pointer[0] * points_to_pixels, pointer[1] * points_to_pixels];
    let rect = monitors
        .iter()
        .find(|rect| p[0] >= rect[0] && p[0] < rect[2] && p[1] >= rect[1] && p[1] < rect[3]);
    let Some(rect) = rect else {
        return pointer;
    };
    let gap = 8.0;
    let left = rect[0] / points_to_pixels + gap;
    let top = rect[1] / points_to_pixels + gap;
    let right = (rect[2] / points_to_pixels - popup[0] - gap).max(left);
    let bottom = (rect[3] / points_to_pixels - popup[1] - gap).max(top);
    [pointer[0].clamp(left, right), pointer[1].clamp(top, bottom)]
}

fn render_companion_menu(
    ctx: &egui::Context,
    sessions: &[SessionInfo],
    known_projects: &[CompanionKnownProject],
    target: &SessionInfo,
    preset_pending: bool,
) -> Option<CompanionMenuAction> {
    let open = ctx.data(|d| {
        d.get_temp::<bool>(egui::Id::new(MENU_OPEN_KEY))
            .unwrap_or(false)
    });
    if !open {
        return None;
    }

    let menu_pos: [f32; 2] = ctx.data(|d| {
        d.get_temp(egui::Id::new(MENU_POS_KEY))
            .unwrap_or([20.0, 20.0])
    });
    let origin = ctx
        .input(|input| input.viewport().outer_rect)
        .map(|rect| rect.min)
        .unwrap_or(egui::Pos2::ZERO);
    let desired = [origin.x + menu_pos[0], origin.y + menu_pos[1]];
    #[cfg(target_os = "windows")]
    let popup = {
        let scale = ctx.input(|input| input.viewport().native_pixels_per_point.unwrap_or(1.0));
        let monitors = crate::screen::monitor_rects_physical().unwrap_or_default();
        popup_position_for_monitors(desired, [POPUP_W, POPUP_H], scale, &monitors)
    };
    #[cfg(not(target_os = "windows"))]
    let popup = desired;
    let popup_position = egui::pos2(popup[0], popup[1]);
    let mut selected: Option<CompanionMenuAction> = None;

    // Native eframe viewport: no clipping to the GIF-sized root viewport,
    // no WindowGeometryKey updates, and readable independent menu controls.
    ctx.show_viewport_immediate(
        egui::ViewportId::from_hash_of("companion-controls"),
        egui::ViewportBuilder::default()
            .with_title("Companion controls")
            .with_inner_size([POPUP_W, POPUP_H])
            .with_min_inner_size([POPUP_W, POPUP_H])
            .with_position(popup_position)
            .with_decorations(false)
            .with_resizable(false)
            .with_always_on_top()
            .with_active(true),
        |popup_ctx, _class| {
            let was_focused = ctx.data(|data| {
                data.get_temp::<bool>(egui::Id::new(MENU_POPUP_FOCUSED_KEY))
                    .unwrap_or(false)
            });
            let focused = popup_ctx.input(|input| input.viewport().focused);
            if focused == Some(true) {
                ctx.data_mut(|data| {
                    data.insert_temp(egui::Id::new(MENU_POPUP_FOCUSED_KEY), true);
                });
            }
            let should_close = popup_ctx.input(|input| {
                input.key_pressed(egui::Key::Escape)
                    || input.viewport().close_requested()
                    || (was_focused && focused == Some(false))
            });
            if should_close {
                ctx.data_mut(|d| d.insert_temp(egui::Id::new(MENU_OPEN_KEY), false));
                return;
            }

            egui::CentralPanel::default()
                .frame(
                    egui::Frame::none()
                        .fill(egui::Color32::from_rgb(25, 25, 29))
                        .inner_margin(egui::Margin::same(12.0)),
                )
                .show(popup_ctx, |ui| {
                    ui.horizontal(|ui| {
                        ui.heading(egui::RichText::new("Companion").size(18.0));
                        if ui.button("Close ✕").clicked() {
                            ctx.data_mut(|d| {
                                d.insert_temp(egui::Id::new(MENU_OPEN_KEY), false);
                            });
                        }
                    });
                    ui.separator();

                    ui.label(egui::RichText::new("Preset target").strong());
                    let mut view = ctx
                        .data(|d| d.get_temp::<u8>(egui::Id::new(MENU_SHOW_KNOWN_KEY)))
                        .unwrap_or(0);
                    ui.horizontal(|ui| {
                        ui.selectable_value(&mut view, 0, "Active");
                        ui.selectable_value(&mut view, 1, "All open");
                        ui.selectable_value(&mut view, 2, "Known");
                    });
                    ctx.data_mut(|d| {
                        d.insert_temp(egui::Id::new(MENU_SHOW_KNOWN_KEY), view);
                    });

                    let mut query: String = ctx
                        .data(|d| d.get_temp(egui::Id::new(MENU_PROJECT_QUERY_KEY)))
                        .unwrap_or_default();
                    ui.add(
                        egui::TextEdit::singleline(&mut query)
                            .hint_text("Search projects or paths"),
                    );
                    ctx.data_mut(|d| {
                        d.insert_temp(egui::Id::new(MENU_PROJECT_QUERY_KEY), query.clone());
                    });

                    let mut matches = 0;
                    egui::ScrollArea::vertical()
                        .id_source("companion-project-list")
                        .max_height(126.0)
                        .show(ui, |ui| {
                            if view == 2 {
                                for known in known_projects.iter().rev() {
                                    let name = project_display_name(&known.cwd);
                                    if !query.trim().is_empty()
                                        && !name.to_lowercase().contains(&query.to_lowercase())
                                        && !known.cwd.to_lowercase().contains(&query.to_lowercase())
                                    {
                                        continue;
                                    }
                                    matches += 1;
                                    let live = project_session_indices(sessions)
                                        .into_iter()
                                        .map(|index| &sessions[index])
                                        .find(|session| session.cwd == known.cwd);
                                    let label = if live.is_some() { "Open" } else { "Remembered" };
                                    if ui
                                        .selectable_label(
                                            target.cwd == known.cwd,
                                            format!("{name}  ·  {label}"),
                                        )
                                        .on_hover_text(&known.cwd)
                                        .clicked()
                                    {
                                        selected = Some(match live {
                                            Some(live) => CompanionMenuAction::SelectProject(
                                                live.session_id.clone(),
                                            ),
                                            None => CompanionMenuAction::SelectKnownProject(
                                                known.cwd.clone(),
                                            ),
                                        });
                                    }
                                    ui.label(
                                        egui::RichText::new(&known.cwd)
                                            .size(11.0)
                                            .color(egui::Color32::GRAY),
                                    );
                                }
                            }
                            for index in project_session_indices(sessions) {
                                if view == 2 {
                                    continue;
                                }
                                let project = &sessions[index];
                                let active = session_activity_rank(project) > 0;
                                if view == 0 && !active {
                                    continue;
                                }
                                let name = project_display_name(&project.cwd);
                                if !query.trim().is_empty()
                                    && !name.to_lowercase().contains(&query.to_lowercase())
                                    && !project.cwd.to_lowercase().contains(&query.to_lowercase())
                                {
                                    continue;
                                }
                                matches += 1;
                                let status = if project.status == "waiting-input" {
                                    "Needs input"
                                } else if active {
                                    "Working"
                                } else {
                                    "Idle"
                                };
                                if ui
                                    .selectable_label(
                                        project.session_id == target.session_id,
                                        format!("{name}  ·  {status}"),
                                    )
                                    .on_hover_text(&project.cwd)
                                    .clicked()
                                {
                                    selected = Some(CompanionMenuAction::SelectProject(
                                        project.session_id.clone(),
                                    ));
                                }
                                ui.label(
                                    egui::RichText::new(&project.cwd)
                                        .size(11.0)
                                        .color(egui::Color32::GRAY),
                                );
                            }
                        });
                    if matches == 0 {
                        ui.label(
                            egui::RichText::new("No matching projects in this view.")
                                .color(egui::Color32::GRAY),
                        );
                    }

                    ui.separator();
                    ui.label(
                        egui::RichText::new(format!(
                            "Editing: {}",
                            project_display_name(&target.cwd)
                        ))
                        .strong(),
                    );
                    let mut scope = if ctx.data(|d| {
                        d.get_temp::<bool>(egui::Id::new(PRESET_SCOPE_GLOBAL_KEY))
                            .unwrap_or(false)
                    }) {
                        PresetScope::Global
                    } else {
                        PresetScope::Project
                    };
                    ui.horizontal(|ui| {
                        ui.label("Preset scope:");
                        ui.selectable_value(&mut scope, PresetScope::Project, "Project");
                        ui.selectable_value(&mut scope, PresetScope::Global, "Global");
                    });
                    ctx.data_mut(|d| {
                        d.insert_temp(
                            egui::Id::new(PRESET_SCOPE_GLOBAL_KEY),
                            scope == PresetScope::Global,
                        );
                    });

                    if target.status == "unavailable" {
                        ui.colored_label(
                            egui::Color32::LIGHT_RED,
                            "Selected project closed. Choose an open project to edit presets.",
                        );
                    }
                    if target.status == "offline" {
                        ui.label(
                            egui::RichText::new("Remembered project · preset catalog may be stale")
                                .size(11.0)
                                .color(egui::Color32::YELLOW),
                        );
                    }
                    if let Some(preset_state) = &target.preset {
                        let current = match scope {
                            PresetScope::Project => {
                                project_current(preset_state).unwrap_or("Inherit")
                            }
                            PresetScope::Global => preset_state.global.as_deref().unwrap_or("None"),
                        };
                        ui.add_enabled_ui(!preset_pending, |ui| {
                            egui::ComboBox::from_id_source("companion-preset-combobox")
                                .selected_text(current)
                                .width(290.0)
                                .show_ui(ui, |ui| {
                                    if scope == PresetScope::Project
                                        && ui
                                            .selectable_label(
                                                project_current(preset_state).is_none(),
                                                "Inherit",
                                            )
                                            .clicked()
                                    {
                                        selected = Some(CompanionMenuAction::SelectPreset(
                                            PresetMenuAction {
                                                scope,
                                                preset: None,
                                                inherit: true,
                                            },
                                        ));
                                    }
                                    let choices = match scope {
                                        PresetScope::Project => project_catalog(preset_state),
                                        PresetScope::Global => &preset_state.global_available,
                                    };
                                    for name in choices {
                                        let is_active = match scope {
                                            PresetScope::Project => {
                                                project_current(preset_state) == Some(name)
                                            }
                                            PresetScope::Global => {
                                                preset_state.global.as_deref() == Some(name)
                                            }
                                        };
                                        if ui.selectable_label(is_active, name).clicked() {
                                            selected = Some(CompanionMenuAction::SelectPreset(
                                                PresetMenuAction {
                                                    scope,
                                                    preset: Some(name.clone()),
                                                    inherit: false,
                                                },
                                            ));
                                        }
                                    }
                                });
                        });
                        if let Some(message) = preset_state.message.as_deref() {
                            ui.label(egui::RichText::new(message).size(11.0));
                        } else if preset_pending {
                            ui.label("Applying preset…");
                        }
                    } else {
                        ui.label("This project has not published preset state.");
                    }

                    ui.separator();
                    let size = ctx.data(|d| {
                        d.get_temp::<f32>(egui::Id::new(SIZE_KEY))
                            .unwrap_or(DEFAULT_SIZE)
                    });
                    ui.horizontal(|ui| {
                        ui.label("Overlay size:");
                        for (label, preset) in SIZE_PRESETS {
                            if ui
                                .selectable_label((size - preset).abs() < 0.5, *label)
                                .clicked()
                            {
                                ctx.data_mut(|d| d.insert_temp(egui::Id::new(SIZE_KEY), *preset));
                            }
                        }
                    });

                    let opening = popup_ctx.data(|data| {
                        data.get_temp::<bool>(project_open_pending_id(&target.cwd))
                            .unwrap_or(false)
                    });
                    let open_error = popup_ctx.data(|data| {
                        data.get_temp::<String>(project_open_error_id(&target.cwd))
                            .unwrap_or_default()
                    });
                    ui.horizontal(|ui| {
                        if ui
                            .add_enabled(
                                !opening,
                                egui::Button::new(if opening {
                                    "Opening…"
                                } else {
                                    "Open project folder"
                                }),
                            )
                            .clicked()
                        {
                            start_project_directory_open(popup_ctx, &target.cwd, &target.cwd);
                        }
                        if ui.button("Copy path").clicked() {
                            popup_ctx.copy_text(target.cwd.clone());
                        }
                        if ui.button("Quit").on_hover_text("Quit Companion").clicked() {
                            ctx.data_mut(|data| {
                                data.insert_temp(egui::Id::new("companion_quit"), true);
                            });
                        }
                    });
                    if !open_error.is_empty() {
                        ui.colored_label(egui::Color32::LIGHT_RED, open_error);
                    }
                });
        },
    );
    selected
}

fn fit_text(ctx: &egui::Context, text: &str, font_id: &egui::FontId, max_width: f32) -> String {
    let measure = |s: &str| -> f32 {
        ctx.fonts(|f| f.layout_no_wrap(s.to_string(), font_id.clone(), egui::Color32::WHITE))
            .rect
            .width()
    };
    if measure(text) <= max_width {
        return text.to_string();
    }
    let ellipsis = "…";
    let budget = (max_width - measure(ellipsis)).max(0.0);
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut lo = 0usize;
    let mut hi = chars.len();
    while lo < hi {
        let mid = (lo + hi + 1) / 2;
        let end = chars[mid - 1].0 + chars[mid - 1].1.len_utf8();
        if measure(&text[..end]) <= budget {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    if lo == 0 {
        return ellipsis.to_string();
    }
    let end = chars[lo - 1].0 + chars[lo - 1].1.len_utf8();
    format!("{}{ellipsis}", &text[..end])
}

#[cfg(unix)]
fn is_pid_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(not(unix))]
fn is_pid_alive(_pid: u32) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::{
        agent_detail_tooltip, apply_config, attention_key, attention_stroke,
        attention_type_for_status, choose_session, config_key, grid_dims, handle_drag_start,
        pending_preset_request_should_clear, place_window, popup_position_for_monitors,
        preset_request_completed, preset_target_session_index, project_session_indices,
        restore_window_position, selected_session_index, session_activity_rank,
        should_apply_geometry, size_from_config, visible_on_monitor, window_size, ConfigKey,
        PendingPresetRequest, PresetScope, SessionInfo, WindowGeometryKey, GAP,
    };
    use crate::state::{CompanionAgentDetail, CompanionConfigState, CompanionPresetState};

    fn session(id: &str, status: &str, agents: &[&str]) -> SessionInfo {
        SessionInfo {
            session_id: id.to_string(),
            cwd: format!("/{id}"),
            active_agents: agents.iter().map(|s| s.to_string()).collect(),
            active_agent_details: Vec::new(),
            status: status.to_string(),
            attention_seq: 0,
            pid: Some(1),
            active_agent: None,
            config: None,
            preset: None,
        }
    }

    fn preset_state(
        effective: Option<&str>,
        project: Option<&str>,
        global: Option<&str>,
        project_available: &[&str],
        global_available: &[&str],
    ) -> CompanionPresetState {
        CompanionPresetState {
            current: effective.map(str::to_string),
            available: project_available.iter().map(|v| (*v).to_string()).collect(),
            effective: effective.map(str::to_string),
            project: project.map(str::to_string),
            global: global.map(str::to_string),
            project_available: project_available.iter().map(|v| (*v).to_string()).collect(),
            global_available: global_available.iter().map(|v| (*v).to_string()).collect(),
            message: None,
            last_request_id: None,
            result_ok: None,
            last_scope: None,
        }
    }

    #[test]
    fn pending_preset_request_clears_when_target_session_disappears() {
        let pending = PendingPresetRequest {
            request_id: "req-1".into(),
            session_id: "target".into(),
        };
        let target = session("target", "idle", &["intro"]);

        assert!(!pending_preset_request_should_clear(
            std::slice::from_ref(&target),
            &pending
        ));
        assert!(pending_preset_request_should_clear(&[], &pending));
    }

    #[test]
    fn pending_preset_request_keeps_cross_session_completion_matching() {
        let pending = PendingPresetRequest {
            request_id: "req-handoff".into(),
            session_id: "target".into(),
        };
        let target = session("target", "idle", &["intro"]);
        let mut successor = session("successor", "idle", &["intro"]);
        let mut preset = preset_state(None, None, None, &[], &[]);
        preset.last_request_id = Some("req-handoff".into());
        successor.preset = Some(preset);

        assert!(pending_preset_request_should_clear(
            &[target, successor],
            &pending
        ));
    }

    #[test]
    fn waiting_input_wins() {
        let sessions = vec![
            session("idle", "idle", &["intro"]),
            session("waiting", "waiting-input", &["input"]),
        ];
        assert_eq!(choose_session(&sessions), Some(1));
    }

    #[test]
    fn non_intro_active_agents_win_over_idle_intro() {
        let sessions = vec![
            session("idle", "idle", &["intro"]),
            session("busy-agent", "idle", &["designer"]),
        ];
        assert_eq!(choose_session(&sessions), Some(1));
    }

    #[test]
    fn busy_wins_when_no_active_agents() {
        let sessions = vec![
            session("idle", "idle", &["intro"]),
            session("busy", "busy", &[]),
        ];
        assert_eq!(choose_session(&sessions), Some(1));
    }

    #[test]
    fn falls_back_to_newest_retained_session() {
        let sessions = vec![
            session("first", "idle", &["intro"]),
            session("second", "idle", &["intro"]),
        ];
        assert_eq!(choose_session(&sessions), Some(1));
    }

    #[test]
    fn pinned_menu_target_wins_over_automatic_activity_selection() {
        let sessions = vec![
            session("active", "waiting-input", &["input"]),
            session("target", "idle", &["intro"]),
        ];
        assert_eq!(selected_session_index(&sessions, Some("target")), Some(1));
    }

    #[test]
    fn missing_menu_target_falls_back_to_active_session() {
        let sessions = vec![
            session("idle", "idle", &["intro"]),
            session("active", "busy", &["fixer"]),
        ];
        assert_eq!(selected_session_index(&sessions, Some("gone")), Some(1));
    }

    #[test]
    fn popup_renders_without_repositioning_the_animation_viewport() {
        let ctx = egui::Context::default();
        let sessions = vec![
            session("display", "busy", &["fixer"]),
            session("edit", "idle", &["intro"]),
        ];
        ctx.data_mut(|data| {
            data.insert_temp(egui::Id::new(super::MENU_OPEN_KEY), true);
            data.insert_temp(egui::Id::new(super::MENU_POS_KEY), [20.0, 20.0]);
        });
        let mut input = egui::RawInput::default();
        input.screen_rect = Some(egui::Rect::from_min_size(
            egui::Pos2::ZERO,
            egui::Vec2::new(1920.0, 1080.0),
        ));
        let output = ctx.run(input, |ctx| {
            assert!(
                super::render_companion_menu(ctx, &sessions, &[], &sessions[1], false).is_none()
            );
        });
        let commands = &output.viewport_output[&egui::ViewportId::ROOT].commands;
        assert!(!commands
            .iter()
            .any(|command| matches!(command, egui::ViewportCommand::OuterPosition(_))));
    }

    #[test]
    fn native_popup_clamps_near_screen_edges_and_negative_monitor_origins() {
        let screens = [[0.0, 0.0, 1920.0, 1080.0], [-1600.0, 0.0, 0.0, 900.0]];
        let popup = [382.0, 460.0];
        assert_eq!(
            popup_position_for_monitors([1900.0, 1000.0], popup, 1.0, &screens),
            [1530.0, 612.0]
        );
        assert_eq!(
            popup_position_for_monitors([-1580.0, 100.0], popup, 1.0, &screens),
            [-1580.0, 100.0]
        );
        assert_eq!(
            popup_position_for_monitors([-50.0, 890.0], popup, 1.0, &screens),
            [-390.0, 432.0]
        );
        assert_eq!(
            popup_position_for_monitors([1850.0, 900.0], popup, 2.0, &screens),
            [1850.0, 900.0]
        );
    }

    #[test]
    fn editing_project_does_not_change_displayed_session_or_geometry() {
        let mut alpha = session("alpha", "idle", &["intro"]);
        alpha.cwd = "/work/alpha".into();
        let mut beta = session("beta", "waiting-input", &["input"]);
        beta.cwd = "/work/beta".into();
        let sessions = vec![alpha, beta];

        let displayed_idx = selected_session_index(&sessions, Some("alpha")).unwrap();
        let edit_idx = preset_target_session_index(&sessions, Some("beta"), displayed_idx);
        assert_eq!(displayed_idx, 0);
        assert_eq!(edit_idx, Some(1));
        assert_eq!(sessions[displayed_idx].cwd, "/work/alpha");
        assert_eq!(sessions[edit_idx.unwrap()].cwd, "/work/beta");
        assert_eq!(selected_session_index(&sessions, Some("alpha")), Some(0));
        assert_eq!(
            preset_target_session_index(&sessions, Some("gone"), 0),
            None
        );
        assert_eq!(preset_target_session_index(&sessions, None, 0), Some(0));

        let original = WindowGeometryKey {
            session_id: "alpha".into(),
            project_key: "/work/alpha".into(),
            position: "bottom-right".into(),
            custom_x: Some(100),
            custom_y: Some(100),
            size_px: 120,
            cols: 1,
            rows: 1,
            screen_w: 1920,
            screen_h: 1080,
        };
        assert!(!should_apply_geometry(false, Some(&original), &original));
    }

    #[test]
    fn saved_position_visible_only_if_recoverable_on_actual_monitor() {
        let monitors = [[0.0, 0.0, 1920.0, 1080.0], [-1600.0, 0.0, 0.0, 900.0]];
        let size = [120.0, 120.0];
        assert!(visible_on_monitor([100.0, 100.0], size, 1.0, &monitors));
        assert!(visible_on_monitor([-1500.0, 120.0], size, 1.0, &monitors));
        assert!(visible_on_monitor([-750.0, 120.0], size, 2.0, &monitors));
        assert!(!visible_on_monitor([3000.0, 120.0], size, 1.0, &monitors));
        assert!(!visible_on_monitor([-1600.0, 901.0], size, 1.0, &monitors));
        assert!(!visible_on_monitor([1890.0, 1060.0], size, 1.0, &monitors));
        assert!(!visible_on_monitor([f32::NAN, 100.0], size, 1.0, &monitors));
        assert!(!visible_on_monitor([100.0, 100.0], size, 0.0, &monitors));
        assert!(!visible_on_monitor([100.0, 100.0], size, 1.0, &[]));
    }

    #[test]
    fn vanished_editor_target_does_not_fall_back_to_displayed_project() {
        let mut alpha = session("displayed", "busy", &["fixer"]);
        alpha.cwd = "/projects/alpha".into();
        let sessions = vec![alpha];
        let displayed = selected_session_index(&sessions, Some("displayed")).unwrap();
        let editing = preset_target_session_index(&sessions, Some("gone-beta"), displayed);
        assert_eq!(
            editing, None,
            "the missing editor must never write to alpha"
        );
        assert_eq!(sessions[displayed].cwd, "/projects/alpha");
    }

    #[test]
    fn project_picker_deduplicates_live_sessions_by_cwd() {
        let mut alpha_old = session("alpha-old", "busy", &["fixer"]);
        alpha_old.cwd = "/projects/alpha".into();
        let mut alpha_new = session("alpha-new", "idle", &["intro"]);
        alpha_new.cwd = "/projects/alpha".into();
        let mut beta = session("beta", "waiting-input", &["input"]);
        beta.cwd = "/projects/beta".into();
        let sessions = vec![alpha_old, alpha_new, beta];

        assert_eq!(project_session_indices(&sessions), vec![0, 2]);
        assert!(session_activity_rank(&sessions[project_session_indices(&sessions)[0]]) > 0);
    }

    #[test]
    fn picker_favors_waiting_input_over_busy_and_idle_for_same_project() {
        let mut waiting = session("waiting", "waiting-input", &["input"]);
        waiting.cwd = "/projects/alpha".into();
        let mut busy = session("busy", "busy", &["fixer"]);
        busy.cwd = "/projects/alpha".into();
        let mut idle = session("idle", "idle", &["intro"]);
        idle.cwd = "/projects/alpha".into();

        let sessions = vec![waiting, busy, idle];
        assert_eq!(project_session_indices(&sessions), vec![0]);
        assert_eq!(session_activity_rank(&sessions[0]), 3);
    }

    #[test]
    fn preset_completion_can_arrive_on_a_non_owner_session() {
        let mut owner = session("owner", "idle", &["intro"]);
        owner.preset = Some(preset_state(
            Some("one"),
            Some("one"),
            Some("one"),
            &["one", "two"],
            &["one", "two"],
        ));
        let mut displayed = session("displayed", "idle", &["intro"]);
        let mut displayed_preset = preset_state(
            Some("two"),
            Some("two"),
            Some("one"),
            &["one", "two"],
            &["one", "two"],
        );
        displayed_preset.last_request_id = Some("req-7".into());
        displayed_preset.result_ok = Some(true);
        displayed.preset = Some(displayed_preset);

        assert!(preset_request_completed(&[owner, displayed], "req-7"));
        assert!(!preset_request_completed(
            &[session("other", "idle", &["intro"])],
            "req-7"
        ));
    }

    #[test]
    fn config_size_defaults_and_presets_work() {
        assert_eq!(size_from_config("small"), 80.0);
        assert_eq!(size_from_config("medium"), 120.0);
        assert_eq!(size_from_config("large"), 160.0);
        assert_eq!(size_from_config("xl"), 200.0);
        assert_eq!(size_from_config("unknown"), 120.0);
    }

    #[test]
    fn top_left_is_gap_gap() {
        assert_eq!(
            place_window("top-left", [1440.0, 900.0], [240.0, 240.0]),
            [GAP, GAP]
        );
    }

    #[test]
    fn bottom_right_stays_anchored_when_height_grows() {
        let small = place_window("bottom-right", [1440.0, 900.0], [240.0, 240.0]);
        let tall = place_window("bottom-right", [1440.0, 900.0], [240.0, 480.0]);
        assert!(tall[1] < small[1]);
        assert!((tall[1] + 480.0 + GAP - 900.0).abs() < 0.01);
    }

    #[test]
    fn top_right_moves_left_when_width_grows() {
        let small = place_window("top-right", [1440.0, 900.0], [240.0, 240.0]);
        let wide = place_window("top-right", [1440.0, 900.0], [480.0, 240.0]);
        assert!(wide[0] < small[0]);
    }

    #[test]
    fn bottom_right_stays_anchored_when_width_grows() {
        let small = place_window("bottom-right", [1440.0, 900.0], [240.0, 240.0]);
        let wide = place_window("bottom-right", [1440.0, 900.0], [480.0, 240.0]);
        assert!(wide[0] < small[0]);
        assert!((wide[0] + 480.0 + GAP - 1440.0).abs() < 0.01);
    }

    #[test]
    fn bottom_left_stays_anchored_when_height_grows() {
        let small = place_window("bottom-left", [1440.0, 900.0], [240.0, 240.0]);
        let tall = place_window("bottom-left", [1440.0, 900.0], [240.0, 480.0]);
        assert_eq!(tall[0], GAP);
        assert!(tall[1] < small[1]);
        assert!((tall[1] + 480.0 + GAP - 900.0).abs() < 0.01);
    }

    #[test]
    fn oversized_window_uses_best_effort_gap_anchor() {
        assert_eq!(
            place_window("bottom-right", [300.0, 300.0], [500.0, 500.0]),
            [GAP, GAP]
        );
    }

    #[test]
    fn restore_clamps_origin_zero_positions() {
        assert_eq!(
            restore_window_position([1400.0, 850.0], [1440.0, 900.0], [120.0, 120.0]),
            [1310.0, 770.0]
        );
    }

    #[test]
    fn restore_preserves_negative_origin_monitor_positions() {
        assert_eq!(
            restore_window_position([-900.0, 40.0], [1440.0, 900.0], [120.0, 120.0]),
            [-900.0, 40.0]
        );
    }

    #[test]
    fn restore_preserves_positive_offset_secondary_monitor_positions() {
        assert_eq!(
            restore_window_position([2200.0, 80.0], [1440.0, 900.0], [120.0, 120.0]),
            [2200.0, 80.0]
        );
    }

    #[test]
    fn geometry_reapply_is_suppressed_during_drag_and_resumes_after_release() {
        let applied = WindowGeometryKey {
            session_id: "owner".into(),
            project_key: "/project".into(),
            position: "bottom-right".into(),
            custom_x: None,
            custom_y: None,
            size_px: 120,
            cols: 1,
            rows: 1,
            screen_w: 1440,
            screen_h: 900,
        };
        let crossed_monitor = WindowGeometryKey {
            screen_w: 2560,
            screen_h: 1440,
            ..applied.clone()
        };

        assert!(!should_apply_geometry(
            true,
            Some(&applied),
            &crossed_monitor
        ));
        assert!(should_apply_geometry(
            false,
            Some(&applied),
            &crossed_monitor
        ));
        assert!(!should_apply_geometry(
            false,
            Some(&crossed_monitor),
            &crossed_monitor
        ));
    }

    #[test]
    fn geometry_key_changes_with_layout_inputs() {
        let base = WindowGeometryKey {
            session_id: "a".into(),
            project_key: "/a".into(),
            position: "bottom-right".into(),
            custom_x: None,
            custom_y: None,
            size_px: 120,
            cols: 1,
            rows: 1,
            screen_w: 1440,
            screen_h: 900,
        };
        assert_ne!(
            base,
            WindowGeometryKey {
                cols: 2,
                ..base.clone()
            }
        );
        assert_ne!(
            base,
            WindowGeometryKey {
                rows: 2,
                ..base.clone()
            }
        );
        assert_ne!(
            base,
            WindowGeometryKey {
                size_px: 160,
                ..base.clone()
            }
        );
        assert_ne!(
            base,
            WindowGeometryKey {
                screen_w: 1600,
                ..base.clone()
            }
        );
        assert_ne!(
            base,
            WindowGeometryKey {
                position: "top-left".into(),
                ..base.clone()
            }
        );
        assert_ne!(
            base.clone(),
            WindowGeometryKey {
                session_id: "b".into(),
                ..base
            }
        );
    }

    #[test]
    fn grid_dims_remains_stable() {
        assert_eq!(grid_dims(1), (1, 1));
        assert_eq!(grid_dims(4), (2, 2));
    }

    #[test]
    fn window_size_scales_with_grid() {
        assert_eq!(window_size(120.0, 2, 3), [240.0, 360.0]);
    }

    #[test]
    fn config_key_tracks_only_config_position_and_size() {
        let cfg = CompanionConfigState {
            enabled: true,
            position: "top-left".into(),
            size: "large".into(),
            gif_pack: "default".into(),
            loop_style: "classic".into(),
            speed: 1.0,
        };
        assert_eq!(
            config_key(Some(&cfg)),
            Some(ConfigKey {
                position: "top-left".into(),
                size: "large".into(),
                gif_pack: "default".into(),
                loop_style: "classic".into(),
                speed_bits: 1.0f32.to_bits(),
            })
        );
        assert_eq!(config_key(None), None);
    }

    #[test]
    fn config_tuple_change_detection_preserves_local_picker_on_session_updates() {
        let previous = Some(ConfigKey {
            position: "bottom-right".into(),
            size: "medium".into(),
            gif_pack: "default".into(),
            loop_style: "classic".into(),
            speed_bits: 1.0f32.to_bits(),
        });
        let unchanged = Some(ConfigKey {
            position: "bottom-right".into(),
            size: "medium".into(),
            gif_pack: "default".into(),
            loop_style: "classic".into(),
            speed_bits: 1.0f32.to_bits(),
        });
        let moved = Some(ConfigKey {
            position: "top-left".into(),
            size: "medium".into(),
            gif_pack: "default".into(),
            loop_style: "classic".into(),
            speed_bits: 1.0f32.to_bits(),
        });
        let resized = Some(ConfigKey {
            position: "bottom-right".into(),
            size: "large".into(),
            gif_pack: "default".into(),
            loop_style: "classic".into(),
            speed_bits: 1.0f32.to_bits(),
        });

        assert_eq!(previous, unchanged);
        assert_ne!(previous, moved);
        assert_ne!(previous, resized);
    }

    #[test]
    fn apply_config_updates_size_only_for_config_changes() {
        let mut position = "bottom-right".to_string();
        let mut size = 200.0;
        let mut gif_pack = "default".to_string();
        let mut loop_style = "classic".to_string();
        let mut speed = 1.0;
        let cfg = ConfigKey {
            position: "top-left".into(),
            size: "small".into(),
            gif_pack: "default".into(),
            loop_style: "smooth".into(),
            speed_bits: 2.0f32.to_bits(),
        };

        apply_config(
            Some(&cfg),
            &mut position,
            &mut size,
            &mut gif_pack,
            &mut loop_style,
            &mut speed,
        );
        assert_eq!(position, "top-left");
        assert_eq!(size, 80.0);
        assert_eq!(gif_pack, "default");
        assert_eq!(loop_style, "smooth");
        assert_eq!(speed, 2.0);

        apply_config(
            None,
            &mut position,
            &mut size,
            &mut gif_pack,
            &mut loop_style,
            &mut speed,
        );
        assert_eq!(position, "bottom-right");
        assert_eq!(size, 120.0);
        assert_eq!(gif_pack, "default");
        assert_eq!(loop_style, "classic");
        assert_eq!(speed, 1.0);
    }

    fn primary_button_event(pos: egui::Pos2, pressed: bool) -> egui::Event {
        egui::Event::PointerButton {
            pos,
            button: egui::PointerButton::Primary,
            pressed,
            modifiers: egui::Modifiers::default(),
        }
    }

    fn run_drag_frame(
        ctx: &egui::Context,
        events: Vec<egui::Event>,
        menu_open: bool,
        project_key: &str,
        drag_key: &mut Option<String>,
    ) -> usize {
        let screen_rect =
            egui::Rect::from_min_size(egui::Pos2::ZERO, egui::Vec2::new(800.0, 600.0));
        let mut raw = egui::RawInput::default();
        raw.screen_rect = Some(screen_rect);
        raw.events = events;
        let full = ctx.run(raw, |ctx| {
            handle_drag_start(ctx, menu_open, project_key, drag_key);
        });
        full.viewport_output
            .get(&egui::ViewportId::ROOT)
            .map(|vo| {
                vo.commands
                    .iter()
                    .filter(|c| matches!(c, egui::ViewportCommand::StartDrag))
                    .count()
            })
            .unwrap_or(0)
    }

    #[test]
    fn drag_gesture_via_context_emits_exactly_one_start_drag() {
        use eframe::egui;
        let ctx = egui::Context::default();
        let mut drag_key: Option<String> = None;
        let project_key = "proj";
        let pos = egui::Pos2::new(10.0, 10.0);

        // idle
        assert_eq!(
            run_drag_frame(&ctx, vec![], false, project_key, &mut drag_key),
            0
        );
        assert_eq!(drag_key, None);
        // press edge — single StartDrag, arms drag key
        assert_eq!(
            run_drag_frame(
                &ctx,
                vec![primary_button_event(pos, true)],
                false,
                project_key,
                &mut drag_key
            ),
            1
        );
        assert_eq!(drag_key, Some(project_key.to_owned()));
        // held frames — primary_down stays true internally, primary_pressed false — must not re-emit
        for _ in 0..3 {
            assert_eq!(
                run_drag_frame(&ctx, vec![], false, project_key, &mut drag_key),
                0,
                "held frame must not emit StartDrag"
            );
        }
        // release — no StartDrag
        assert_eq!(
            run_drag_frame(
                &ctx,
                vec![primary_button_event(pos, false)],
                false,
                project_key,
                &mut drag_key
            ),
            0
        );
    }

    #[test]
    fn drag_start_suppressed_when_menu_open_via_context() {
        use eframe::egui;
        let ctx = egui::Context::default();
        let mut drag_key: Option<String> = None;
        let project_key = "proj";
        let pos = egui::Pos2::new(20.0, 20.0);

        // press with menu open must not emit
        assert_eq!(
            run_drag_frame(
                &ctx,
                vec![primary_button_event(pos, true)],
                true,
                project_key,
                &mut drag_key
            ),
            0
        );
        assert_eq!(drag_key, None);
        // even subsequent held frames must not emit
        assert_eq!(
            run_drag_frame(&ctx, vec![], true, project_key, &mut drag_key),
            0
        );
    }

    #[test]
    fn agent_detail_tooltip_includes_live_model_and_variant() {
        let detail = CompanionAgentDetail {
            session_id: "child".into(),
            agent: "fixer".into(),
            model: Some("provider/model".into()),
            variant: Some("high".into()),
        };
        assert_eq!(
            agent_detail_tooltip(&detail),
            "fixer\nModel: provider/model\nVariant: high"
        );
    }

    #[test]
    fn attention_key_changes_for_each_waiting_input_generation() {
        let mut waiting = session("waiting", "waiting-input", &["input"]);
        waiting.attention_seq = 1;
        assert_eq!(attention_key(&waiting), Some(("waiting".into(), 1)));

        waiting.attention_seq = 2;
        assert_eq!(attention_key(&waiting), Some(("waiting".into(), 2)));

        waiting.status = "idle".into();
        assert_eq!(attention_key(&waiting), None);
    }

    #[test]
    fn native_attention_is_reserved_for_waiting_input() {
        assert_eq!(
            attention_type_for_status("waiting-input"),
            Some(egui::UserAttentionType::Informational)
        );
        assert_eq!(attention_type_for_status("error"), None);
        assert_eq!(attention_type_for_status("failed"), None);
        assert_eq!(attention_type_for_status("busy"), None);
        assert_eq!(attention_type_for_status("idle"), None);
    }

    #[test]
    fn attention_outline_is_reserved_for_waiting_input() {
        assert!(attention_stroke("waiting-input").is_some());
        assert!(attention_stroke("error").is_none());
        assert!(attention_stroke("failed").is_none());
        assert!(attention_stroke("busy").is_none());
        assert!(attention_stroke("idle").is_none());
    }
}
