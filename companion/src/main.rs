#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod gifs;
mod niri;
mod screen;
mod singleton;
mod state;

use singleton::acquire;

fn main() -> eframe::Result {
    // Exit immediately if another instance is already running
    if !acquire() {
        return Ok(());
    }

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("oh-my-opencode-slim-companion")
            .with_app_id("oh-my-opencode-slim-companion")
            .with_decorations(false)
            .with_transparent(true)
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
