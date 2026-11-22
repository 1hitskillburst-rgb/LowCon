use egui::{
    vec2, Align, Layout, Rounding, Stroke, Ui,
};
use crate::app::state::ModelProfile;
use crate::ui::components::{format_number, local_dot};
use crate::ui::theme::*;

/// Render the Models Management View
pub fn render_models_view(
    ui: &mut Ui,
    models: &mut Vec<ModelProfile>,
    active_model_id: &mut String,
    new_model_path: &mut String,
) {
    ui.vertical(|ui| {
        // Top Header
        egui::Frame::none()
            .fill(COLOR_BG)
            .stroke(Stroke::new(1.0_f32, COLOR_LINE))
            .inner_margin(egui::Margin::symmetric(28.0, 12.0))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(
                        egui::RichText::new("Workspace / ")
                            .size(13.0)
                            .color(COLOR_MUTE),
                    );
                    ui.label(
                        egui::RichText::new("Models")
                            .strong()
                            .size(13.0)
                            .color(COLOR_INK),
                    );

                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.horizontal(|ui| {
                            local_dot(ui);
                            ui.label(
                                egui::RichText::new("In-process GGUF · No remote server")
                                    .size(12.5)
                                    .color(COLOR_INK2),
                            );
                        });
                    });
                });
            });

        // Content Area
        egui::ScrollArea::vertical()
            .id_salt("models_view_scroll")
            .show(ui, |ui| {
                ui.add_space(24.0);

                let max_width = 720.0;
                ui.vertical_centered(|ui| {
                    ui.set_width(ui.available_width().min(max_width));

                    // Title & Description
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.label(
                                egui::RichText::new("Local Model Management")
                                    .strong()
                                    .size(24.0)
                                    .color(COLOR_INK),
                            );
                            ui.add_space(2.0);
                            ui.label(
                                egui::RichText::new("Manage GGUF models stored on your device. Only one model stays loaded in memory at a time.")
                                    .size(13.0)
                                    .color(COLOR_MUTE),
                            );
                        });
                    });

                    ui.add_space(20.0);

                    // Add Model Card
                    egui::Frame::none()
                        .fill(COLOR_WHITE)
                        .stroke(Stroke::new(1.0_f32, COLOR_LINE))
                        .rounding(Rounding::same(8.0))
                        .inner_margin(egui::Margin::same(16.0))
                        .show(ui, |ui| {
                            ui.label(
                                egui::RichText::new("ADD LOCAL .GGUF MODEL")
                                    .strong()
                                    .size(11.5)
                                    .color(COLOR_MUTE),
                            );
                            ui.add_space(8.0);

                            ui.horizontal(|ui| {
                                let edit = egui::TextEdit::singleline(new_model_path)
                                    .hint_text("Absolute file path to .gguf file (e.g. C:\\models\\qwen-4b.gguf)")
                                    .desired_width(ui.available_width() - 130.0);
                                ui.add(edit);

                                let add_btn = ui.add(
                                    egui::Button::new(
                                        egui::RichText::new("Add Model")
                                            .strong()
                                            .color(COLOR_WHITE),
                                    )
                                    .fill(COLOR_BLUE)
                                    .rounding(Rounding::same(6.0))
                                    .min_size(vec2(110.0, 30.0)),
                                );
                                if add_btn.clicked() {
                                    let path_clean = new_model_path.trim().to_string();
                                    if !path_clean.is_empty() {
                                        let name = path_clean
                                            .rsplit(&['/', '\\'][..])
                                            .next()
                                            .unwrap_or("Custom Model")
                                            .replace(".gguf", "");

                                        models.push(ModelProfile {
                                            id: format!("m_{}", models.len() + 1),
                                            name,
                                            file_path: path_clean,
                                            architecture: "llama".into(),
                                            quantization: "Q4_K_M".into(),
                                            context_limit: 8192,
                                            context_override: None,
                                            file_size_bytes: 3_800_000_000,
                                            is_loaded: false,
                                            ram_footprint_mb: None,
                                        });
                                        new_model_path.clear();
                                    }
                                }
                            });
                        });

                    ui.add_space(24.0);

                    // Models list
                    ui.horizontal(|ui| {
                        ui.label(
                            egui::RichText::new("CONFIGURED MODELS")
                                .strong()
                                .size(11.5)
                                .color(COLOR_MUTE),
                        );
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            ui.label(
                                egui::RichText::new(format!("{} models configured", models.len()))
                                    .size(12.0)
                                    .color(COLOR_MUTE),
                            );
                        });
                    });

                    ui.add_space(8.0);

                    let mut model_to_remove: Option<usize> = None;

                    for (idx, model) in models.iter_mut().enumerate() {
                        let is_active = model.id == *active_model_id;

                        egui::Frame::none()
                            .fill(COLOR_WHITE)
                            .stroke(Stroke::new(
                                if is_active { 1.5_f32 } else { 1.0_f32 },
                                if is_active { COLOR_BLUE } else { COLOR_LINE },
                            ))
                            .rounding(Rounding::same(8.0))
                            .inner_margin(egui::Margin::same(16.0))
                            .show(ui, |ui| {
                                ui.horizontal(|ui| {
                                    ui.vertical(|ui| {
                                        ui.horizontal(|ui| {
                                            ui.label(
                                                egui::RichText::new(&model.name)
                                                    .strong()
                                                    .size(16.0)
                                                    .color(COLOR_INK),
                                            );

                                            if model.is_loaded {
                                                render_badge(ui, "LOADED", COLOR_GREEN);
                                            }
                                            if is_active {
                                                render_badge(ui, "ACTIVE", COLOR_BLUE);
                                            }
                                        });

                                        ui.add_space(4.0);

                                        // Metadata specs
                                        let size_mb = model.file_size_bytes / (1024 * 1024);
                                        let meta_str = format!(
                                            "Arch: {} · Quant: {} · Context: {} tokens · File size: {} MB",
                                            model.architecture,
                                            model.quantization,
                                            format_number(model.context_limit),
                                            size_mb
                                        );
                                        ui.label(
                                            egui::RichText::new(meta_str)
                                                .size(12.0)
                                                .color(COLOR_MUTE),
                                        );

                                        ui.add_space(2.0);
                                        ui.label(
                                            egui::RichText::new(&model.file_path)
                                                .size(11.5)
                                                .color(COLOR_INK2),
                                        );
                                    });

                                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                        if !is_active {
                                            if ui.button(egui::RichText::new("Remove").color(COLOR_MUTE)).clicked() {
                                                model_to_remove = Some(idx);
                                            }
                                        }

                                        if model.is_loaded {
                                            if ui
                                                .button(
                                                    egui::RichText::new("Unload")
                                                        .color(egui::Color32::from_rgb(0xD9, 0x38, 0x3A)),
                                                )
                                                .on_hover_text("Release model weights and VRAM/RAM")
                                                .clicked()
                                            {
                                                model.is_loaded = false;
                                                model.ram_footprint_mb = None;
                                            }
                                        } else {
                                            let load_btn = ui.add(
                                                egui::Button::new(
                                                    egui::RichText::new("Load")
                                                        .strong()
                                                        .color(COLOR_INK),
                                                )
                                                .fill(COLOR_HOVER),
                                            );
                                            if load_btn.clicked() {
                                                model.is_loaded = true;
                                                model.ram_footprint_mb = Some(2420);
                                                *active_model_id = model.id.clone();
                                            }
                                        }

                                        if !is_active {
                                            if ui.button(egui::RichText::new("Set Active")).clicked() {
                                                *active_model_id = model.id.clone();
                                            }
                                        }
                                    });
                                });

                                // Context Override slider
                                ui.add_space(8.0);
                                ui.separator();
                                ui.add_space(4.0);

                                ui.horizontal(|ui| {
                                    ui.label(
                                        egui::RichText::new("Working Context Limit Override:")
                                            .size(12.0)
                                            .color(COLOR_INK2),
                                    );
                                    let mut override_val = model.context_override.unwrap_or(model.context_limit);
                                    let slider = egui::Slider::new(&mut override_val, 1024..=32768)
                                        .step_by(512.0)
                                        .suffix(" tokens");
                                    if ui.add(slider).changed() {
                                        model.context_override = Some(override_val);
                                    }
                                });
                            });

                        ui.add_space(10.0);
                    }

                    if let Some(to_remove) = model_to_remove {
                        models.remove(to_remove);
                    }
                });
            });
    });
}

fn render_badge(ui: &mut Ui, text: &str, color: egui::Color32) {
    let frame = egui::Frame::none()
        .fill(egui::Color32::from_rgba_premultiplied(color.r(), color.g(), color.b(), 30))
        .rounding(Rounding::same(4.0))
        .inner_margin(egui::Margin::symmetric(6.0, 2.0));

    frame.show(ui, |ui| {
        ui.label(
            egui::RichText::new(text)
                .strong()
                .size(10.5)
                .color(color),
        );
    });
}
