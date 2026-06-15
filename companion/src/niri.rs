use std::process::Command;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;

use serde::Deserialize;

const APP_ID: &str = "oh-my-opencode-slim-companion";
const TITLE: &str = "oh-my-opencode-slim-companion";
const GAP: f64 = 10.0;

#[derive(Debug, Deserialize)]
struct NiriWindow {
    id: u64,
    pid: Option<u32>,
    app_id: Option<String>,
    title: Option<String>,
    is_floating: Option<bool>,
    layout: Option<NiriLayout>,
}

#[derive(Debug, Deserialize)]
struct NiriOutput {
    logical: Option<NiriOutputLogical>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
struct NiriOutputLogical {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Deserialize)]
struct NiriLayout {
    tile_pos_in_workspace_view: Option<[f64; 2]>,
}

pub fn retry_move_current_window(
    socket: String,
    pid: u32,
    generation: u64,
    current_generation: Arc<AtomicU64>,
    position: String,
    target_position: Option<[f32; 2]>,
    screen: [f32; 2],
    win_size: [f32; 2],
) {
    for _ in 0..6 {
        std::thread::sleep(Duration::from_millis(150));
        if current_generation.load(Ordering::Relaxed) != generation {
            return;
        }
        let Some((id, delta)) =
            resolve_move(&socket, pid, &position, target_position, screen, win_size)
        else {
            continue;
        };
        if move_window(&socket, &id, delta).is_ok() {
            return;
        }
    }
}

fn resolve_move(
    socket: &str,
    pid: u32,
    position: &str,
    target_position: Option<[f32; 2]>,
    screen: [f32; 2],
    win_size: [f32; 2],
) -> Option<(String, [i32; 2])> {
    let windows_output = Command::new("niri")
        .arg("msg")
        .arg("--json")
        .arg("windows")
        .env("NIRI_SOCKET", socket)
        .output()
        .ok()?;
    if !windows_output.status.success() {
        return None;
    }
    let outputs_output = Command::new("niri")
        .arg("msg")
        .arg("--json")
        .arg("outputs")
        .env("NIRI_SOCKET", socket)
        .output()
        .ok();
    let outputs_json = outputs_output
        .as_ref()
        .filter(|output| output.status.success())
        .map(|output| output.stdout.as_slice());

    resolve_move_from_json(
        &windows_output.stdout,
        outputs_json,
        pid,
        position,
        target_position,
        screen,
        win_size,
    )
}

fn resolve_move_from_json(
    windows_json: &[u8],
    outputs_json: Option<&[u8]>,
    pid: u32,
    position: &str,
    target_position: Option<[f32; 2]>,
    screen: [f32; 2],
    win_size: [f32; 2],
) -> Option<(String, [i32; 2])> {
    let windows: Vec<NiriWindow> = serde_json::from_slice(windows_json).ok()?;
    let win = windows.into_iter().find(|w| matches_window(w, pid))?;
    let current = win.layout?.tile_pos_in_workspace_view?;
    let outputs = outputs_json.and_then(parse_outputs);
    let output = outputs
        .as_deref()
        .and_then(|outputs| {
            target_position
                .map(|pos| [pos[0] as f64, pos[1] as f64])
                .and_then(|pos| output_containing_position(outputs, pos))
                .or_else(|| output_for_position(outputs, current))
        })
        .unwrap_or(NiriOutputLogical {
            x: 0.0,
            y: 0.0,
            width: screen[0] as f64,
            height: screen[1] as f64,
        });
    let desired = target_position
        .map(|pos| {
            clamp_position_on_output(
                [pos[0] as f64, pos[1] as f64],
                output,
                [win_size[0] as f64, win_size[1] as f64],
            )
        })
        .unwrap_or_else(|| {
            place_window_on_output(position, output, [win_size[0] as f64, win_size[1] as f64])
        });
    let dx = (desired[0] - current[0]).round() as i32;
    let dy = (desired[1] - current[1]).round() as i32;
    if dx.abs() <= 1 && dy.abs() <= 1 {
        return None;
    }
    let max_delta = movement_delta_limit(output);
    if dx.abs() > max_delta || dy.abs() > max_delta {
        return None;
    }
    Some((win.id.to_string(), [dx, dy]))
}

fn movement_delta_limit(output: NiriOutputLogical) -> i32 {
    (output.width.max(output.height) * 2.0).ceil().max(1.0) as i32
}

fn parse_outputs(json: &[u8]) -> Option<Vec<NiriOutputLogical>> {
    let outputs: std::collections::HashMap<String, NiriOutput> =
        serde_json::from_slice(json).ok()?;
    let logicals = outputs
        .into_values()
        .filter_map(|output| output.logical)
        .filter(|logical| {
            logical.x.is_finite()
                && logical.y.is_finite()
                && logical.width.is_finite()
                && logical.height.is_finite()
                && logical.width > 1.0
                && logical.height > 1.0
        })
        .collect::<Vec<_>>();
    (!logicals.is_empty()).then_some(logicals)
}

fn output_for_position(outputs: &[NiriOutputLogical], pos: [f64; 2]) -> Option<NiriOutputLogical> {
    output_containing_position(outputs, pos).or_else(|| outputs.first().copied())
}

fn output_containing_position(
    outputs: &[NiriOutputLogical],
    pos: [f64; 2],
) -> Option<NiriOutputLogical> {
    outputs.iter().copied().find(|output| {
        output.x <= pos[0]
            && pos[0] < output.x + output.width
            && output.y <= pos[1]
            && pos[1] < output.y + output.height
    })
}

fn place_window_on_output(
    position: &str,
    output: NiriOutputLogical,
    win_size: [f64; 2],
) -> [f64; 2] {
    let (win_w, win_h) = (win_size[0], win_size[1]);
    let (x, y) = match position {
        "bottom-left" => (output.x + GAP, output.y + output.height - win_h - GAP),
        "top-right" => (output.x + output.width - win_w - GAP, output.y + GAP),
        "top-left" => (output.x + GAP, output.y + GAP),
        _ => (
            output.x + output.width - win_w - GAP,
            output.y + output.height - win_h - GAP,
        ),
    };
    let x_min = output.x + GAP;
    let y_min = output.y + GAP;
    let x_max = (output.x + output.width - win_w - GAP).max(x_min);
    let y_max = (output.y + output.height - win_h - GAP).max(y_min);
    [x.clamp(x_min, x_max), y.clamp(y_min, y_max)]
}

fn clamp_position_on_output(
    position: [f64; 2],
    output: NiriOutputLogical,
    win_size: [f64; 2],
) -> [f64; 2] {
    let x_min = output.x + GAP;
    let y_min = output.y + GAP;
    let x_max = (output.x + output.width - win_size[0] - GAP).max(x_min);
    let y_max = (output.y + output.height - win_size[1] - GAP).max(y_min);
    [
        position[0].clamp(x_min, x_max),
        position[1].clamp(y_min, y_max),
    ]
}

fn matches_window(win: &NiriWindow, pid: u32) -> bool {
    win.pid == Some(pid)
        && win.is_floating == Some(true)
        && (win.app_id.as_deref() == Some(APP_ID) || win.title.as_deref() == Some(TITLE))
}

fn move_window(socket: &str, id: &str, delta: [i32; 2]) -> std::io::Result<()> {
    let args = build_move_args(id, delta);
    Command::new("niri")
        .args(args)
        .env("NIRI_SOCKET", socket)
        .output()
        .map(|_| ())
}

pub(crate) fn build_move_args(id: &str, delta: [i32; 2]) -> Vec<String> {
    vec![
        "msg".into(),
        "action".into(),
        "move-floating-window".into(),
        "--id".into(),
        id.into(),
        "-x".into(),
        format_delta(delta[0]),
        "-y".into(),
        format_delta(delta[1]),
    ]
}

fn format_delta(delta: i32) -> String {
    if delta > 0 {
        format!("+{delta}")
    } else {
        delta.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_move_args, clamp_position_on_output, matches_window, output_for_position,
        parse_outputs, place_window_on_output, resolve_move_from_json, NiriOutputLogical,
        NiriWindow,
    };

    const FIXTURE: &str = r#"[
      {"id":1,"pid":11,"app_id":"other","title":"x","is_floating":true,"layout":{"tile_pos_in_workspace_view":[1,2]}},
      {"id":2,"pid":1234,"app_id":"oh-my-opencode-slim-companion","title":"oh-my-opencode-slim-companion","is_floating":true,"layout":{"tile_pos_in_workspace_view":[2424,944]}},
      {"id":3,"pid":1234,"app_id":"oh-my-opencode-slim-companion","title":"oh-my-opencode-slim-companion","is_floating":false,"layout":{"tile_pos_in_workspace_view":[0,0]}},
      {"id":4,"pid":1234,"app_id":"wrong","title":"wrong","is_floating":true,"layout":{"tile_pos_in_workspace_view":[0,0]}},
      {"id":5,"pid":9999,"app_id":"oh-my-opencode-slim-companion","title":"oh-my-opencode-slim-companion","is_floating":true,"layout":{"tile_pos_in_workspace_view":[0,0]}},
      {"id":6,"pid":1234,"app_id":"oh-my-opencode-slim-companion","title":"oh-my-opencode-slim-companion","is_floating":true,"layout":null},
      {"id":7,"pid":1234,"app_id":"oh-my-opencode-slim-companion","title":"oh-my-opencode-slim-companion","is_floating":true,"layout":{"tile_pos_in_workspace_view":null}}
    ]"#;

    const OUTPUTS: &str = r#"{
      "HDMI-A-1": {"logical":{"x":0,"y":0,"width":2560,"height":1080,"scale":1,"transform":"Normal"}}
    }"#;

    const TWO_OUTPUTS: &str = r#"{
      "left": {"logical":{"x":0,"y":0,"width":1920,"height":1080,"scale":1,"transform":"Normal"}},
      "right": {"logical":{"x":1920,"y":0,"width":1280,"height":720,"scale":1,"transform":"Normal"}}
    }"#;

    #[test]
    fn parse_fixture_json() {
        let windows: Vec<NiriWindow> = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(windows.len(), 7);
    }

    #[test]
    fn command_args_builder_exact_args() {
        assert_eq!(
            build_move_args("2", [-234, -114]),
            vec![
                "msg",
                "action",
                "move-floating-window",
                "--id",
                "2",
                "-x",
                "-234",
                "-y",
                "-114"
            ]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn command_args_prefix_positive_deltas() {
        assert_eq!(
            build_move_args("2", [2180, 820]),
            vec![
                "msg",
                "action",
                "move-floating-window",
                "--id",
                "2",
                "-x",
                "+2180",
                "-y",
                "+820"
            ]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn select_matching_window_by_pid_and_identity() {
        let windows: Vec<NiriWindow> = serde_json::from_str(FIXTURE).unwrap();
        let ok = windows.into_iter().find(|w| matches_window(w, 1234));
        assert_eq!(ok.unwrap().id, 2);
    }

    #[test]
    fn reject_wrong_pid_app_id_and_non_floating() {
        let windows: Vec<NiriWindow> = serde_json::from_str(FIXTURE).unwrap();
        assert!(!matches_window(&windows[1], 9999));
        assert!(!matches_window(&windows[2], 1234));
        assert!(!matches_window(&windows[3], 1234));
        assert!(!matches_window(&windows[0], 1234));
    }

    #[test]
    fn compute_delta_for_observed_evidence() {
        let desired = place_window_on_output(
            "bottom-right",
            NiriOutputLogical {
                x: 0.0,
                y: 0.0,
                width: 2560.0,
                height: 1080.0,
            },
            [360.0, 240.0],
        );
        assert_eq!(desired, [2190.0, 830.0]);
        let dx = (desired[0] - 2424.0).round() as i32;
        let dy = (desired[1] - 944.0).round() as i32;
        assert_eq!([dx, dy], [-234, -114]);
    }

    #[test]
    fn top_left_desired_is_gap_gap() {
        assert_eq!(
            place_window_on_output(
                "top-left",
                NiriOutputLogical {
                    x: 0.0,
                    y: 0.0,
                    width: 2560.0,
                    height: 1080.0,
                },
                [360.0, 240.0],
            ),
            [10.0, 10.0]
        );
    }

    #[test]
    fn no_op_when_already_positioned() {
        let desired = place_window_on_output(
            "top-left",
            NiriOutputLogical {
                x: 0.0,
                y: 0.0,
                width: 2560.0,
                height: 1080.0,
            },
            [360.0, 240.0],
        );
        let dx = (desired[0] - 10.0).round() as i32;
        let dy = (desired[1] - 10.0).round() as i32;
        assert!(dx.abs() <= 1 && dy.abs() <= 1);
    }

    #[test]
    fn resolve_move_uses_niri_output_bounds() {
        assert_eq!(
            resolve_move_from_json(
                FIXTURE.as_bytes(),
                Some(OUTPUTS.as_bytes()),
                1234,
                "bottom-right",
                None,
                [2550.0, 1100.0],
                [360.0, 240.0],
            ),
            Some(("2".into(), [-234, -114]))
        );
    }

    #[test]
    fn custom_position_uses_target_output() {
        let windows = r#"[
          {"id":2,"pid":1234,"app_id":"oh-my-opencode-slim-companion","title":"oh-my-opencode-slim-companion","is_floating":true,"layout":{"tile_pos_in_workspace_view":[10,10]}}
        ]"#;
        assert_eq!(
            resolve_move_from_json(
                windows.as_bytes(),
                Some(TWO_OUTPUTS.as_bytes()),
                1234,
                "top-left",
                Some([2100.0, 80.0]),
                [1920.0, 1080.0],
                [120.0, 120.0],
            ),
            Some(("2".into(), [2090, 70]))
        );
    }

    #[test]
    fn large_output_deltas_are_allowed_with_derived_limit() {
        let windows = r#"[
          {"id":2,"pid":1234,"app_id":"oh-my-opencode-slim-companion","title":"oh-my-opencode-slim-companion","is_floating":true,"layout":{"tile_pos_in_workspace_view":[8000,4000]}}
        ]"#;
        let outputs = r#"{
          "big": {"logical":{"x":0,"y":0,"width":10000,"height":5000,"scale":1,"transform":"Normal"}}
        }"#;
        assert_eq!(
            resolve_move_from_json(
                windows.as_bytes(),
                Some(outputs.as_bytes()),
                1234,
                "top-left",
                None,
                [10000.0, 5000.0],
                [120.0, 120.0],
            ),
            Some(("2".into(), [-7990, -3990]))
        );
    }

    #[test]
    fn non_zero_origin_output_places_relative_to_that_output() {
        let output = NiriOutputLogical {
            x: 1920.0,
            y: 100.0,
            width: 1280.0,
            height: 720.0,
        };
        assert_eq!(
            place_window_on_output("bottom-right", output, [120.0, 120.0]),
            [3070.0, 690.0]
        );
    }

    #[test]
    fn custom_position_is_clamped_to_output() {
        let output = NiriOutputLogical {
            x: 0.0,
            y: 0.0,
            width: 500.0,
            height: 300.0,
        };
        assert_eq!(
            clamp_position_on_output([460.0, -20.0], output, [120.0, 120.0]),
            [370.0, 10.0]
        );
    }

    #[test]
    fn output_selection_prefers_current_window_output() {
        let outputs = vec![
            NiriOutputLogical {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            NiriOutputLogical {
                x: 1920.0,
                y: 0.0,
                width: 1280.0,
                height: 720.0,
            },
        ];
        assert_eq!(
            output_for_position(&outputs, [2000.0, 20.0]).unwrap(),
            outputs[1]
        );
    }

    #[test]
    fn parse_outputs_ignores_invalid_outputs() {
        assert_eq!(parse_outputs(OUTPUTS.as_bytes()).unwrap().len(), 1);
        assert!(
            parse_outputs(br#"{"bad":{"logical":{"x":0,"y":0,"width":0,"height":0}}}"#).is_none()
        );
    }

    #[test]
    fn no_op_on_missing_null_layout_fields() {
        let windows: Vec<NiriWindow> = serde_json::from_str(FIXTURE).unwrap();
        assert!(windows.iter().any(|w| w.layout.is_none()));
        assert!(windows.iter().any(|w| {
            w.layout
                .as_ref()
                .and_then(|l| l.tile_pos_in_workspace_view)
                .is_none()
        }));
    }
}
