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
    read_state, start_watcher, write_project_window_position, CompanionConfigState, SessionInfo,
    WindowPositionState,
};

const DEFAULT_SIZE: f32 = 120.0;
const GAP: f32 = 10.0;

const SIZE_PRESETS: &[(&str, f32)] = &[
    ("S  ·  80px", 80.0),
    ("M  ·  120px", 120.0),
    ("L  ·  160px", 160.0),
    ("XL  ·  200px", 200.0),
];

const SIZE_KEY: &str = "companion_size";
const MENU_OPEN_KEY: &str = "companion_menu_open";
const MENU_POS_KEY: &str = "companion_menu_pos";

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

fn choose_owned_session(sessions: &[SessionInfo], owner_session_id: Option<&str>) -> Option<usize> {
    if let Some(owner_session_id) = owner_session_id {
        return sessions
            .iter()
            .position(|session| session.session_id == owner_session_id);
    }

    choose_session(sessions)
}

pub struct CompanionApp {
    state_path: std::path::PathBuf,
    owner_session_id: Option<String>,
    sessions: Vec<SessionInfo>,
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
            niri_generation: Arc::new(AtomicU64::new(0)),
        }
    }

    fn poll(&mut self) -> bool {
        if self.rx.try_recv().is_ok() {
            while self.rx.try_recv().is_ok() {}
            let state = read_state(&self.state_path);
            self.sessions = state.sessions;
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
            self.window_positions = state.window_positions;
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

        let Some(selected_idx) =
            choose_owned_session(&self.sessions, self.owner_session_id.as_deref())
        else {
            if self.owner_session_id.is_some() {
                crate::log::debug(format!(
                    "close owner session missing owner={:?} sessions={}",
                    self.owner_session_id,
                    self.sessions.len()
                ));
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                return;
            }
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
        let time_seconds = ctx.input(|input| input.time);
        let agent_frames: Vec<AnimationFrame> = if session.active_agents.is_empty() {
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
                .collect()
        } else {
            session
                .active_agents
                .iter()
                .filter_map(|agent| {
                    self.gifs.frame(
                        ctx,
                        agent,
                        &self.gif_pack,
                        self.speed,
                        &self.loop_style,
                        time_seconds,
                    )
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
        if self.applied_geometry.as_ref() != Some(&geometry) {
            ctx.send_viewport_cmd(egui::ViewportCommand::InnerSize(egui::vec2(win_w, win_h)));
            let pos = saved_position
                .map(|pos| restore_window_position([pos.x, pos.y], self.screen, [win_w, win_h]))
                .unwrap_or_else(|| {
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

        let menu_open = ctx.data(|d| {
            d.get_temp::<bool>(egui::Id::new(MENU_OPEN_KEY))
                .unwrap_or(false)
        });
        if !menu_open && ctx.input(|i| i.pointer.primary_pressed()) {
            self.drag_project_key = Some(project_key.clone());
        }
        if self.drag_project_key.is_some() && ctx.input(|i| i.pointer.primary_down()) {
            ctx.send_viewport_cmd(egui::ViewportCommand::StartDrag);
        }
        if ctx.input(|i| i.pointer.primary_released()) {
            if let Some(project_key) = self.drag_project_key.take() {
                if let Some(rect) = ctx.input(|i| i.viewport().outer_rect) {
                    let position = WindowPositionState {
                        x: rect.min.x,
                        y: rect.min.y,
                    };
                    if write_project_window_position(&self.state_path, &project_key, position)
                        .is_ok()
                    {
                        self.window_positions.insert(project_key, position);
                        self.applied_geometry = None;
                    }
                }
            }
        }

        if ctx.input(|i| i.pointer.secondary_released()) {
            let cursor = ctx.input(|i| i.pointer.interact_pos()).unwrap_or_default();
            ctx.data_mut(|d| {
                d.insert_temp(egui::Id::new(MENU_POS_KEY), [cursor.x, cursor.y]);
                d.insert_temp(egui::Id::new(MENU_OPEN_KEY), true);
            });
        }

        egui::CentralPanel::default()
            .frame(
                egui::Frame::none()
                    .fill(egui::Color32::BLACK)
                    .inner_margin(egui::Margin::ZERO),
            )
            .show(ctx, |ui| {
                ui.spacing_mut().item_spacing = egui::Vec2::ZERO;
                render_session(ui, ctx, &session, &agent_frames, self.size, win_w, win_h);
            });

        render_size_picker(ctx);
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
    agent_frames: &[AnimationFrame],
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

    for (i, frame) in agent_frames.iter().enumerate() {
        if let Some(&cell) = rects.get(i) {
            ui.painter()
                .image(frame.texture_id, cell, frame.uv, egui::Color32::WHITE);
        }
    }

    let label_h = (current_size * 0.15).clamp(13.0, 30.0);
    let font_size = (current_size * 0.09).clamp(9.0, 13.0);
    let strip =
        egui::Rect::from_min_size(egui::pos2(0.0, win_h - label_h), egui::vec2(win_w, label_h));
    ui.painter()
        .rect_filled(strip, 0.0, egui::Color32::from_black_alpha(185));

    let fid = egui::FontId::proportional(font_size);
    let label = fit_text(ctx, &project, &fid, win_w - 10.0);
    ui.painter().text(
        strip.center(),
        egui::Align2::CENTER_CENTER,
        &label,
        fid,
        egui::Color32::WHITE,
    );
}

fn render_size_picker(ctx: &egui::Context) {
    let open: bool = ctx.data(|d| d.get_temp(egui::Id::new(MENU_OPEN_KEY)).unwrap_or(false));
    if !open {
        return;
    }

    if ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
        ctx.data_mut(|d| d.insert_temp(egui::Id::new(MENU_OPEN_KEY), false));
        return;
    }

    let pos: [f32; 2] = ctx.data(|d| {
        d.get_temp(egui::Id::new(MENU_POS_KEY))
            .unwrap_or([20.0, 20.0])
    });
    let size: f32 = ctx.data(|d| d.get_temp(egui::Id::new(SIZE_KEY)).unwrap_or(DEFAULT_SIZE));

    let response = egui::Area::new(egui::Id::new("size_picker"))
        .fixed_pos(egui::pos2(pos[0], pos[1]))
        .order(egui::Order::Foreground)
        .show(ctx, |ui| {
            egui::Frame::none()
                .fill(egui::Color32::from_rgb(28, 28, 28))
                .stroke(egui::Stroke::new(1.0, egui::Color32::from_gray(70)))
                .inner_margin(egui::Margin::same(8.0))
                .show(ui, |ui| {
                    ui.label(
                        egui::RichText::new("Window size")
                            .size(11.0)
                            .color(egui::Color32::from_rgb(160, 160, 160)),
                    );
                    ui.add_space(4.0);

                    for (label, preset) in SIZE_PRESETS {
                        let active = (size - preset).abs() < 0.5;
                        let text = if active {
                            egui::RichText::new(*label)
                                .size(12.0)
                                .strong()
                                .color(egui::Color32::WHITE)
                        } else {
                            egui::RichText::new(*label)
                                .size(12.0)
                                .color(egui::Color32::from_rgb(200, 200, 200))
                        };
                        if ui
                            .add_sized([144.0, 20.0], egui::Button::new(text).frame(false))
                            .clicked()
                        {
                            ctx.data_mut(|d| {
                                d.insert_temp(egui::Id::new(SIZE_KEY), *preset);
                                d.insert_temp(egui::Id::new(MENU_OPEN_KEY), false);
                            });
                        }
                    }

                    ui.add_space(4.0);
                    ui.separator();
                    ui.add_space(2.0);

                    if ui
                        .add_sized(
                            [144.0, 20.0],
                            egui::Button::new(
                                egui::RichText::new("Close companion")
                                    .size(12.0)
                                    .color(egui::Color32::from_rgb(220, 100, 100)),
                            )
                            .frame(false),
                        )
                        .clicked()
                    {
                        ctx.data_mut(|d| {
                            d.insert_temp(egui::Id::new(MENU_OPEN_KEY), false);
                            d.insert_temp(egui::Id::new("companion_quit"), true);
                        });
                    }
                });
        });

    let clicked_outside = ctx.input(|i| {
        (i.pointer.primary_released() || i.pointer.secondary_released())
            && i.pointer
                .interact_pos()
                .map(|pos| !response.response.rect.contains(pos))
                .unwrap_or(false)
    });
    if clicked_outside {
        ctx.data_mut(|d| d.insert_temp(egui::Id::new(MENU_OPEN_KEY), false));
    }
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
        apply_config, choose_session, config_key, grid_dims, place_window, restore_window_position,
        size_from_config, window_size, ConfigKey, SessionInfo, WindowGeometryKey, GAP,
    };
    use crate::state::CompanionConfigState;

    fn session(id: &str, status: &str, agents: &[&str]) -> SessionInfo {
        SessionInfo {
            session_id: id.to_string(),
            cwd: format!("/{id}"),
            active_agents: agents.iter().map(|s| s.to_string()).collect(),
            status: status.to_string(),
            pid: Some(1),
            active_agent: None,
            config: None,
        }
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
}
