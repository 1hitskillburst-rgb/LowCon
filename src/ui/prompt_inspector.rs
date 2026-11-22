use egui::{
    vec2, Align, Align2, Color32, Layout, Rounding, Stroke,
};
use crate::app::state::PromptInspectorState;
use crate::ui::components::format_number;
use crate::ui::theme::*;

/// Render the Prompt Inspector window/modal
pub fn render_prompt_inspector(ctx: &egui::Context, state: &mut PromptInspectorState) {
    if !state.is_open {
        return;
    }

    let mut is_open = state.is_open;
    let mut close_clicked = false;

    egui::Window::new("Prompt Inspector — Exact Token Breakdown")
        .open(&mut is_open)
        .resizable(true)
        .default_size(vec2(720.0, 560.0))
        .min_size(vec2(540.0, 400.0))
        .anchor(Align2::CENTER_CENTER, vec2(0.0, 0.0))
        .show(ctx, |ui| {
            ui.add_space(4.0);

            // Subtitle explanation
            ui.label(
                egui::RichText::new("Deterministic context assembly view. Everything sent to the local model is inspectable and explainable.")
                    .size(12.5)
                    .color(COLOR_MUTE),
            );

            ui.add_space(12.0);

            // Quick Budget Stats Summary Card
            egui::Frame::none()
                .fill(COLOR_PANEL)
                .stroke(Stroke::new(1.0_f32, COLOR_LINE))
                .rounding(Rounding::same(6.0))
                .inner_margin(egui::Margin::symmetric(14.0, 10.0))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        render_stat_box(ui, "Output Reserve", &format!("{} tokens", format_number(state.output_reserve)));
                        ui.separator();
                        render_stat_box(ui, "Safety Margin", &format!("{} tokens", format_number(state.safety_margin)));
                        ui.separator();
                        render_stat_box(ui, "Remaining Free", &format!("{} tokens", format_number(state.remaining_capacity)));
                    });
                });

            ui.add_space(14.0);

            // Section Token Accounting
            ui.label(
                egui::RichText::new("PACKED SECTIONS")
                    .strong()
                    .size(11.5)
                    .color(COLOR_MUTE),
            );
            ui.add_space(4.0);

            egui::Frame::none()
                .fill(COLOR_WHITE)
                .stroke(Stroke::new(1.0_f32, COLOR_LINE))
                .rounding(Rounding::same(6.0))
                .inner_margin(egui::Margin::symmetric(12.0, 8.0))
                .show(ui, |ui| {
                    for (section_name, token_count) in &state.sections {
                        ui.horizontal(|ui| {
                            ui.label(egui::RichText::new(section_name).size(13.0).color(COLOR_INK));
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                ui.label(
                                    egui::RichText::new(format!("{} tokens", format_number(*token_count)))
                                        .strong()
                                        .size(13.0)
                                        .color(COLOR_INK2),
                                );
                            });
                        });
                        ui.separator();
                    }
                });

            ui.add_space(14.0);

            // Included vs Excluded Candidates
            ui.columns(2, |cols| {
                // Column 1: Included Items
                cols[0].vertical(|ui| {
                    ui.label(
                        egui::RichText::new("INCLUDED IN THIS PROMPT")
                            .strong()
                            .size(11.5)
                            .color(COLOR_GREEN),
                    );
                    ui.add_space(4.0);
                    egui::Frame::none()
                        .fill(COLOR_WHITE)
                        .stroke(Stroke::new(1.0_f32, COLOR_LINE))
                        .rounding(Rounding::same(6.0))
                        .inner_margin(egui::Margin::same(10.0))
                        .show(ui, |ui| {
                            for item in &state.included_items {
                                ui.label(egui::RichText::new(format!("✓ {}", item)).size(12.0).color(COLOR_INK));
                                ui.add_space(2.0);
                            }
                        });
                });

                // Column 2: Excluded Candidates & Reasons
                cols[1].vertical(|ui| {
                    ui.label(
                        egui::RichText::new("EXCLUDED CANDIDATES & REASONS")
                            .strong()
                            .size(11.5)
                            .color(Color32::from_rgb(0xD9, 0x38, 0x3A)),
                    );
                    ui.add_space(4.0);
                    egui::Frame::none()
                        .fill(COLOR_WHITE)
                        .stroke(Stroke::new(1.0_f32, COLOR_LINE))
                        .rounding(Rounding::same(6.0))
                        .inner_margin(egui::Margin::same(10.0))
                        .show(ui, |ui| {
                            for (item, reason) in &state.excluded_candidates {
                                ui.vertical(|ui| {
                                    ui.label(egui::RichText::new(format!("✕ {}", item)).strong().size(12.0).color(COLOR_INK2));
                                    ui.label(egui::RichText::new(format!("  Reason: {}", reason)).size(11.0).color(COLOR_MUTE));
                                });
                                ui.add_space(3.0);
                            }
                        });
                });
            });

            ui.add_space(14.0);

            // Exact Prompt Text Render
            ui.horizontal(|ui| {
                ui.label(
                    egui::RichText::new("EXACT RENDERED PROMPT STRING")
                        .strong()
                        .size(11.5)
                        .color(COLOR_MUTE),
                );
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if ui.button(egui::RichText::new("Copy prompt").size(12.0)).clicked() {
                        ui.output_mut(|o| o.copied_text = state.exact_prompt.clone());
                    }
                });
            });

            ui.add_space(4.0);

            egui::ScrollArea::vertical()
                .id_salt("exact_prompt_view_scroll")
                .max_height(160.0)
                .show(ui, |ui| {
                    egui::Frame::none()
                        .fill(COLOR_WHITE)
                        .stroke(Stroke::new(1.0_f32, COLOR_LINE))
                        .rounding(Rounding::same(6.0))
                        .inner_margin(egui::Margin::same(10.0))
                        .show(ui, |ui| {
                            ui.add(
                                egui::TextEdit::multiline(&mut state.exact_prompt)
                                    .font(egui::TextStyle::Monospace)
                                    .desired_width(ui.available_width())
                                    .desired_rows(6),
                            );
                        });
                });

            ui.add_space(10.0);

            // Bottom close button
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if ui.button(egui::RichText::new("Close Inspector").strong()).clicked() {
                    close_clicked = true;
                }
            });
        });

    if close_clicked {
        is_open = false;
    }
    state.is_open = is_open;
}

fn render_stat_box(ui: &mut egui::Ui, title: &str, value: &str) {
    ui.vertical(|ui| {
        ui.label(egui::RichText::new(title).size(11.0).color(COLOR_MUTE));
        ui.label(egui::RichText::new(value).strong().size(13.0).color(COLOR_INK));
    });
}
