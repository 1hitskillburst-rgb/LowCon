mod app;
mod ui;

fn main() -> eframe::Result<()> {
    let native_options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1280.0, 840.0])
            .with_min_inner_size([960.0, 600.0])
            .with_title("LowCon — Local Model Workbench"),
        ..Default::default()
    };

    eframe::run_native(
        "LowCon",
        native_options,
        Box::new(|_cc| Ok(Box::new(app::LowConApp::default()))),
    )
}
