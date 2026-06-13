use std::sync::mpsc::Receiver;
use std::time::Duration;

use eframe::egui;

use crate::gifs::Gifs;
use crate::screen::primary_size;
use crate::state::{read_state, start_watcher, SessionInfo};

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
        .find(|(_, s)| s.status == "waiting-input")
        .map(|(i, _)| i)
        .or_else(|| {
            sessions
                .iter()
                .enumerate()
                .find(|(_, s)| s.active_agents.iter().any(|agent| agent != "intro"))
                .map(|(i, _)| i)
        })
        .or_else(|| {
            sessions
                .iter()
                .enumerate()
                .find(|(_, s)| s.status == "busy")
                .map(|(i, _)| i)
        })
        .or_else(|| sessions.first().map(|_| 0))
}

pub struct CompanionApp {
    state_path: std::path::PathBuf,
    sessions: Vec<SessionInfo>,
    gifs: Gifs,
    rx: Receiver<()>,
    registered: bool,
    size: f32,
    screen: [f32; 2],
    position: String,
    has_modern_config: bool,
    applied_layout: Option<(String, f32, u32, u32, String)>,
}

impl CompanionApp {
    pub fn new(_cc: &eframe::CreationContext<'_>) -> Self {
        let state_path = crate::state::state_file_path();
        let state = read_state(&state_path);
        let sessions = state.sessions;

        let mut initial_size = DEFAULT_SIZE;
        let mut position = "bottom-right".to_string();
        let has_modern_config = state.config.is_some();
        if let Some(ref cfg) = state.config {
            initial_size = match cfg.size.as_str() {
                "small" => 80.0,
                "medium" => 120.0,
                "large" => 160.0,
                _ => 120.0,
            };
            position = cfg.position.clone();
        }

        let rx = start_watcher(state_path.clone());

        Self {
            state_path,
            sessions,
            gifs: Gifs::new(),
            rx,
            registered: false,
            size: initial_size,
            screen: primary_size(),
            position,
            has_modern_config,
            applied_layout: None,
        }
    }

    fn poll(&mut self) {
        if self.rx.try_recv().is_ok() {
            while self.rx.try_recv().is_ok() {}
            let state = read_state(&self.state_path);
            self.sessions = state.sessions;
            self.has_modern_config = state.config.is_some();
            if let Some(ref cfg) = state.config {
                self.position = cfg.position.clone();
            } else {
                self.position = "bottom-right".to_string();
            }
        }

        let has_modern = self.has_modern_config;
        self.sessions
            .retain(|s| s.pid.map(is_pid_alive).unwrap_or(!has_modern));
    }

    fn initial_pos(&self, win_w: f32, win_h: f32) -> [f32; 2] {
        let (x, y) = match self.position.as_str() {
            "bottom-left" => (GAP, self.screen[1] - win_h - GAP),
            "top-right" => (self.screen[0] - win_w - GAP, GAP),
            "top-left" => (GAP, GAP),
            _ => (self.screen[0] - win_w - GAP, self.screen[1] - win_h - GAP),
        };
        let x_max = (self.screen[0] - win_w - GAP).max(GAP);
        let y_max = (self.screen[1] - win_h - GAP).max(GAP);
        [x.clamp(GAP, x_max), y.clamp(GAP, y_max)]
    }
}

impl eframe::App for CompanionApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.poll();

        let quit = ctx.data(|d| {
            d.get_temp::<bool>(egui::Id::new("companion_quit"))
                .unwrap_or(false)
        });
        if quit || (self.registered && self.sessions.is_empty()) {
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            return;
        }

        if !self.registered {
            self.gifs.register(ctx);
            ctx.data_mut(|d| d.insert_temp(egui::Id::new(SIZE_KEY), self.size));
            self.registered = true;
        }

        self.size = ctx.data(|d| d.get_temp(egui::Id::new(SIZE_KEY)).unwrap_or(DEFAULT_SIZE));

        let Some(selected_idx) = choose_session(&self.sessions) else {
            egui::CentralPanel::default()
                .frame(egui::Frame::none().fill(egui::Color32::TRANSPARENT))
                .show(ctx, |ui| {
                    ui.centered_and_justified(|ui| {
                        ui.label("No active sessions");
                    });
                });
            ctx.request_repaint_after(Duration::from_millis(150));
            return;
        };

        let session = self.sessions[selected_idx].clone();
        let agent_uris: Vec<String> = if session.active_agents.is_empty() {
            vec![self.gifs.uri("intro")]
        } else {
            session
                .active_agents
                .iter()
                .map(|agent| self.gifs.uri(agent))
                .collect()
        };
        let n = agent_uris.len().max(1);
        let (cols, rows) = grid_dims(n);
        let win_w = self.size * cols as f32;
        let win_h = self.size * rows as f32;

        let layout = (
            session.session_id.clone(),
            self.size,
            cols as u32,
            rows as u32,
            self.position.clone(),
        );
        if self.applied_layout.as_ref() != Some(&layout) {
            ctx.send_viewport_cmd(egui::ViewportCommand::InnerSize(egui::vec2(win_w, win_h)));
            let pos = self.initial_pos(win_w, win_h);
            ctx.send_viewport_cmd(egui::ViewportCommand::OuterPosition(egui::pos2(
                pos[0], pos[1],
            )));
            self.applied_layout = Some(layout);
        }

        if ctx.input(|i| i.pointer.primary_down()) {
            ctx.send_viewport_cmd(egui::ViewportCommand::StartDrag);
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
                    .fill(egui::Color32::TRANSPARENT)
                    .inner_margin(egui::Margin::ZERO),
            )
            .show(ctx, |ui| {
                ui.spacing_mut().item_spacing = egui::Vec2::ZERO;
                render_session(ui, ctx, &session, &agent_uris, self.size, win_w, win_h);
            });

        render_size_picker(ctx);
        ctx.request_repaint_after(Duration::from_millis(50));
    }
}

fn render_session(
    ui: &mut egui::Ui,
    ctx: &egui::Context,
    session: &SessionInfo,
    agent_uris: &[String],
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

    let n = agent_uris.len().max(1);
    let (cols, rows) = grid_dims(n);
    let rects = cell_rects(n, cols, rows, current_size);

    for (i, uri) in agent_uris.iter().enumerate() {
        if let Some(&cell) = rects.get(i) {
            ui.put(
                cell,
                egui::Image::new(uri).fit_to_exact_size(egui::vec2(current_size, current_size)),
            );
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

    let pos: [f32; 2] = ctx.data(|d| {
        d.get_temp(egui::Id::new(MENU_POS_KEY))
            .unwrap_or([20.0, 20.0])
    });
    let size: f32 = ctx.data(|d| d.get_temp(egui::Id::new(SIZE_KEY)).unwrap_or(DEFAULT_SIZE));

    egui::Area::new(egui::Id::new("size_picker"))
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
    use super::{choose_session, SessionInfo};

    fn session(id: &str, status: &str, agents: &[&str]) -> SessionInfo {
        SessionInfo {
            session_id: id.to_string(),
            cwd: format!("/{id}"),
            active_agents: agents.iter().map(|s| s.to_string()).collect(),
            status: status.to_string(),
            pid: Some(1),
            active_agent: None,
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
            session("busy", "busy", &["orchestrator"]),
        ];
        assert_eq!(choose_session(&sessions), Some(1));
    }

    #[test]
    fn falls_back_to_first_retained_session() {
        let sessions = vec![
            session("first", "idle", &["intro"]),
            session("second", "idle", &["intro"]),
        ];
        assert_eq!(choose_session(&sessions), Some(0));
    }
}
