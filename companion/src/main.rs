#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod gifs;
mod log;
mod niri;
mod screen;
mod singleton;
mod state;

fn main() -> eframe::Result {
    let Some(owner_session_id) = std::env::var("OH_MY_OPENCODE_SLIM_COMPANION_SESSION_ID")
        .ok()
        .filter(|session_id| !session_id.trim().is_empty())
    else {
        log::debug(format!(
            "exit missing owner_session_id pid={}",
            std::process::id()
        ));
        return Ok(());
    };

    log::debug(format!(
        "start pid={} owner_session_id={}",
        std::process::id(),
        owner_session_id
    ));

    if !singleton::acquire(&owner_session_id) {
        log::debug(format!(
            "exit duplicate owner_session_id={}",
            owner_session_id
        ));
        return Ok(());
    }

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("oh-my-opencode-slim-companion")
            .with_app_id("oh-my-opencode-slim-companion")
            .with_decorations(false)
            .with_transparent(false)
            .with_always_on_top()
            .with_active(false)
            .with_inner_size([120.0, 120.0]),
        // Run as a macOS accessory app: no Dock icon, never steals focus
        // from the terminal when the windows appear.
        event_loop_builder: Some(Box::new(|builder| {
            #[cfg(target_os = "macos")]
            {
                use winit::platform::macos::{ActivationPolicy, EventLoopBuilderExtMacOS};
                builder.with_activation_policy(ActivationPolicy::Accessory);
                builder.with_activate_ignoring_other_apps(false);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = builder;
        })),
        ..Default::default()
    };

    eframe::run_native(
        "oh-my-opencode-slim-companion",
        options,
        Box::new(|cc| Ok(Box::new(app::CompanionApp::new(cc)))),
    )
}
