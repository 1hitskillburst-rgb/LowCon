use egui::{
    vec2, Align, Layout, Pos2, Rect, Rounding, Stroke, Ui,
};
use crate::app::state::{ContextSegmentKey, MemoryNote, TurnContextBudget};
use crate::ui::components::{
    format_number, render_context_row, render_vertical_context_stack, toggle_switch,
};
use crate::ui::theme::*;

/// Render the Right Context & Memory Panel (344px width)
pub fn render_context_panel(
    ui: &mut Ui,
    budget: &TurnContextBudget,
    memory_notes: &[MemoryNote],
    memory_retrieval_enabled: &mut bool,
    hovered_segment: &mut Option<ContextSegmentKey>,
    on_inspect_prompt: &mut bool,
) {
    let panel_width = 344.0;
    ui.set_width(panel_width);

    egui::Frame::none()
        .fill(COLOR_PANEL)
        .stroke(Stroke::new(1.0_f32, COLOR_LINE))
        .inner_margin(egui::Margin {
            left: 22.0,
            right: 22.0,
            top: 22.0,
            bottom: 28.0,
        })
        .show(ui, |ui| {
            egui::ScrollArea::vertical()
                .id_salt("context_panel_scroll")
                .show(ui, |ui| {
                    // Title Header
                    ui.horizontal(|ui| {
                        ui.label(
                            egui::RichText::new("Context window")
                                .strong()
                                .size(15.0)
                                .color(COLOR_INK),
                        );
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            let limit_label = format!("{}K model", budget.total_limit / 1024);
                            ui.label(
                                egui::RichText::new(limit_label)
                                    .size(12.5)
                                    .color(COLOR_MUTE),
                            );
                        });
                    });

                    ui.add_space(14.0);

                    // Big Total Tokens Packed
                    ui.horizontal_wrapped(|ui| {
                        ui.label(
                            egui::RichText::new(format_number(budget.packed_tokens()))
                                .strong()
                                .size(32.0)
                                .color(COLOR_INK),
                        );
                        ui.add_space(4.0);
                        let sub_packed = format!(
                            "of {} tokens packed · {:.0}%",
                            format_number(budget.total_limit),
                            budget.packed_percentage()
                        );
                        ui.label(
                            egui::RichText::new(sub_packed)
                                .size(13.0)
                                .color(COLOR_MUTE),
                        );
                    });

                    let free_text = format!(
                        "{} still free for more history or memory.",
                        format_number(budget.free_tokens())
                    );
                    ui.label(
                        egui::RichText::new(free_text)
                            .size(13.0)
                            .color(COLOR_INK2),
                    );

                    ui.add_space(18.0);

                    // Dual Context Stack + Row Breakdown Display
                    let stack_height = 360.0;
                    ui.horizontal(|ui| {
                        // 44px vertical visual stack
                        render_vertical_context_stack(ui, budget, stack_height, hovered_segment);

                        ui.add_space(12.0);

                        // Row breakdown with exact token numbers
                        ui.vertical(|ui| {
                            for seg in &budget.segments {
                                render_context_row(ui, seg, hovered_segment);
                            }
                        });
                    });

                    ui.add_space(18.0);

                    // Inspect Exact Prompt Button
                    let inspect_btn = ui.add(
                        egui::Button::new(
                            egui::RichText::new("Inspect exact prompt")
                                .strong()
                                .size(13.5)
                                .color(COLOR_INK),
                        )
                        .stroke(Stroke::new(1.0_f32, COLOR_INK))
                        .fill(COLOR_WHITE)
                        .rounding(Rounding::same(8.0))
                        .min_size(vec2(ui.available_width(), 38.0)),
                    );

                    if inspect_btn.clicked() {
                        *on_inspect_prompt = true;
                    }

                    ui.add_space(28.0);

                    // Memory in this prompt section
                    let active_notes_in_prompt: Vec<&MemoryNote> = memory_notes
                        .iter()
                        .filter(|n| n.is_in_active_prompt)
                        .collect();

                    ui.horizontal(|ui| {
                        ui.label(
                            egui::RichText::new("Memory in this prompt")
                                .strong()
                                .size(14.0)
                                .color(COLOR_INK),
                        );
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            let note_stats = format!(
                                "{} of {} notes",
                                active_notes_in_prompt.len(),
                                memory_notes.len()
                            );
                            ui.label(
                                egui::RichText::new(note_stats)
                                    .size(12.0)
                                    .color(COLOR_MUTE),
                            );
                        });
                    });

                    ui.add_space(10.0);

                    if active_notes_in_prompt.is_empty() {
                        ui.label(
                            egui::RichText::new("No memory excerpts injected for this prompt.")
                                .italics()
                                .size(12.5)
                                .color(COLOR_MUTE),
                        );
                    } else {
                        for note in active_notes_in_prompt {
                            render_prompt_memory_note(ui, note);
                            ui.add_space(8.0);
                        }
                    }

                    ui.add_space(16.0);

                    // Memory Retrieval Toggle Row
                    ui.horizontal(|ui| {
                        ui.label(
                            egui::RichText::new("Memory retrieval")
                                .size(13.0)
                                .color(COLOR_INK2),
                        );
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            toggle_switch(ui, memory_retrieval_enabled);
                        });
                    });
                });
        });
}

fn render_prompt_memory_note(ui: &mut Ui, note: &MemoryNote) {
    let border_color = if note.is_pinned {
        COLOR_INK
    } else {
        COLOR_BLUE2
    };

    let cat_text = if note.is_pinned {
        "Pinned project rule"
    } else {
        "Retrieved as relevant"
    };

    egui::Frame::none()
        .inner_margin(egui::Margin {
            left: 12.0,
            right: 4.0,
            top: 4.0,
            bottom: 4.0,
        })
        .show(ui, |ui| {
            // Draw left border line
            let start = ui.cursor().min;
            let line_rect = Rect::from_min_size(
                Pos2::new(start.x - 12.0, start.y),
                vec2(3.0, 36.0),
            );
            ui.painter().rect_filled(line_rect, Rounding::same(1.0), border_color);

            ui.vertical(|ui| {
                ui.label(
                    egui::RichText::new(cat_text)
                        .size(11.5)
                        .color(COLOR_MUTE),
                );
                ui.label(
                    egui::RichText::new(&note.excerpt)
                        .size(13.5)
                        .color(COLOR_INK),
                );
                ui.label(
                    egui::RichText::new(&note.source_reference)
                        .size(11.5)
                        .color(COLOR_MUTE),
                );
            });
        });
}
