use egui::{ColorImage, Context, Rect, TextureHandle, TextureId, TextureOptions};
use std::collections::HashMap;

const DEFAULT_SPEED: f32 = 1.0;
const BASE_SPEED_MULTIPLIER: f32 = 2.0;
const FRAME_RATE: f32 = 24.0;
const FRAME_COUNT: usize = 72;
const SHEET_COLS: usize = 12;
const SHEET_ROWS: usize = 6;

pub struct Gifs {
    sheets: HashMap<&'static str, &'static [u8]>,
    textures: HashMap<&'static str, TextureHandle>,
}

#[derive(Clone, Copy)]
pub struct AnimationFrame {
    pub texture_id: TextureId,
    pub uv: Rect,
}

impl Gifs {
    pub fn new() -> Self {
        let mut sheets: HashMap<&'static str, &'static [u8]> = HashMap::new();
        sheets.insert("council", include_bytes!("../animations/council.jpg"));
        sheets.insert("councillor", include_bytes!("../animations/council.jpg"));
        sheets.insert("designer", include_bytes!("../animations/designer.jpg"));
        sheets.insert("explorer", include_bytes!("../animations/explorer.jpg"));
        sheets.insert("fixer", include_bytes!("../animations/fixer.jpg"));
        sheets.insert("input", include_bytes!("../animations/question.jpg"));
        sheets.insert("intro", include_bytes!("../animations/intro.jpg"));
        sheets.insert("librarian", include_bytes!("../animations/librarian.jpg"));
        sheets.insert("oracle", include_bytes!("../animations/oracle.jpg"));
        sheets.insert(
            "orchestrator",
            include_bytes!("../animations/orchestrator.jpg"),
        );
        Self {
            sheets,
            textures: HashMap::new(),
        }
    }

    pub fn frame(
        &mut self,
        ctx: &Context,
        agent: &str,
        gif_pack: &str,
        speed: f32,
        loop_style: &str,
        time_seconds: f64,
    ) -> Option<AnimationFrame> {
        let name = self.resolve_name(agent, gif_pack);
        self.ensure_texture(ctx, name)?;
        let texture = self.textures.get(name)?;
        Some(AnimationFrame {
            texture_id: texture.id(),
            uv: frame_uv(frame_index(time_seconds, speed, loop_style)),
        })
    }

    fn ensure_texture(&mut self, ctx: &Context, name: &'static str) -> Option<()> {
        if self.textures.contains_key(name) {
            return Some(());
        }
        let bytes = *self.sheets.get(name)?;
        let started = std::time::Instant::now();
        match decode_sprite_sheet(bytes) {
            Ok(image) => {
                let texture = ctx.load_texture(
                    format!("companion-animation-{name}"),
                    image,
                    TextureOptions::LINEAR,
                );
                crate::log::debug(format!(
                    "animation lazy-load name={} bytes={} elapsed_ms={}",
                    name,
                    bytes.len(),
                    started.elapsed().as_millis()
                ));
                self.textures.insert(name, texture);
                Some(())
            }
            Err(err) => {
                crate::log::debug(format!("animation decode failed name={} err={}", name, err));
                None
            }
        }
    }

    fn resolve_name(&self, agent: &str, gif_pack: &str) -> &'static str {
        if gif_pack != "default" {
            return "orchestrator";
        }
        self.sheets
            .get_key_value(agent)
            .map(|(name, _)| *name)
            .unwrap_or("orchestrator")
    }
}

pub fn normalized_speed(speed: f32) -> f32 {
    if speed.is_finite() {
        speed.clamp(0.25, 4.0)
    } else {
        DEFAULT_SPEED
    }
}

fn normalized_loop_style(loop_style: &str) -> &str {
    if loop_style == "smooth" {
        "smooth"
    } else {
        "classic"
    }
}

fn frame_index(time_seconds: f64, speed: f32, loop_style: &str) -> usize {
    let effective_speed = normalized_speed(speed) * BASE_SPEED_MULTIPLIER;
    let tick =
        (time_seconds.max(0.0) * FRAME_RATE as f64 * effective_speed as f64).floor() as usize;
    if normalized_loop_style(loop_style) == "smooth" {
        let period = FRAME_COUNT * 2 - 2;
        let phase = tick % period;
        if phase < FRAME_COUNT {
            phase
        } else {
            period - phase
        }
    } else {
        tick % FRAME_COUNT
    }
}

fn frame_uv(index: usize) -> Rect {
    let col = index % SHEET_COLS;
    let row = index / SHEET_COLS;
    let w = 1.0 / SHEET_COLS as f32;
    let h = 1.0 / SHEET_ROWS as f32;
    Rect::from_min_max(
        egui::pos2(col as f32 * w, row as f32 * h),
        egui::pos2((col + 1) as f32 * w, (row + 1) as f32 * h),
    )
}

fn decode_sprite_sheet(bytes: &[u8]) -> Result<ColorImage, image::ImageError> {
    let image = image::load_from_memory(bytes)?.to_rgba8();
    let size = [image.width() as usize, image.height() as usize];
    Ok(ColorImage::from_rgba_unmultiplied(size, image.as_raw()))
}

#[cfg(test)]
mod tests {
    use super::{frame_index, frame_uv, normalized_speed, FRAME_COUNT};

    #[test]
    fn speed_is_clamped_and_defaults_fast() {
        assert_eq!(normalized_speed(f32::NAN), 1.0);
        assert_eq!(normalized_speed(0.1), 0.25);
        assert_eq!(normalized_speed(9.0), 4.0);
    }

    #[test]
    fn classic_loop_wraps_forward() {
        assert_eq!(frame_index(0.0, 1.0, "classic"), 0);
        assert_eq!(frame_index(1.5, 1.0, "classic"), 0);
        assert_eq!(frame_index(1.5 + 1.0 / 48.0, 1.0, "classic"), 1);
    }

    #[test]
    fn smooth_loop_ping_pongs_without_duplicate_endpoints() {
        assert_eq!(frame_index(0.0, 1.0, "smooth"), 0);
        assert_eq!(
            frame_index((FRAME_COUNT - 1) as f64 / 48.0, 1.0, "smooth"),
            71
        );
        assert_eq!(frame_index(FRAME_COUNT as f64 / 48.0, 1.0, "smooth"), 70);
    }

    #[test]
    fn frame_uv_maps_sprite_grid_cells() {
        let uv = frame_uv(13);
        assert!(uv.min.x > 0.0);
        assert!(uv.min.y > 0.0);
        assert!(uv.max.x <= 1.0);
        assert!(uv.max.y <= 1.0);
    }
}
