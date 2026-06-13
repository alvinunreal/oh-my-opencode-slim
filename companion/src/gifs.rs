use egui::Context;
use std::collections::HashMap;

pub struct Gifs {
    map: HashMap<&'static str, &'static [u8]>,
}

impl Gifs {
    pub fn new() -> Self {
        let mut map: HashMap<&'static str, &'static [u8]> = HashMap::new();
        map.insert("council", include_bytes!("../gifs/council.gif"));
        map.insert("councillor", include_bytes!("../gifs/council.gif"));
        map.insert("designer", include_bytes!("../gifs/designer.gif"));
        map.insert("explorer", include_bytes!("../gifs/explorer.gif"));
        map.insert("fixer", include_bytes!("../gifs/fixer.gif"));
        map.insert("input", include_bytes!("../gifs/question.gif"));
        map.insert("intro", include_bytes!("../gifs/intro.gif"));
        map.insert("librarian", include_bytes!("../gifs/librarian.gif"));
        map.insert("oracle", include_bytes!("../gifs/oracle.gif"));
        map.insert("orchestrator", include_bytes!("../gifs/orchestrator.gif"));
        Self { map }
    }

    pub fn register(&self, ctx: &Context) {
        egui_extras::install_image_loaders(ctx);
        for (name, bytes) in &self.map {
            ctx.include_bytes(format!("bytes://{name}.gif"), *bytes);
        }
    }

    pub fn uri(&self, agent: &str) -> String {
        let name = if self.map.contains_key(agent) {
            agent
        } else {
            "orchestrator"
        };
        format!("bytes://{name}.gif")
    }
}
