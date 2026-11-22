use egui::{
    vec2, Align, Align2, Layout, Rounding, Stroke, Ui,
};
use crate::app::state::MemoryNote;
use crate::ui::components::local_dot;
use crate::ui::theme::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryFilter {
    All,
    Pinned,
    InPrompt,
    AutoExtracted,
}

pub struct MemoryViewState {
    pub search_query: String,
    pub filter: MemoryFilter,
    pub editing_note: Option<MemoryNote>,
    pub show_new_note_dialog: bool,
    pub new_note_title: String,
    pub new_note_content: String,
    pub new_note_is_pinned: bool,
}

impl Default for MemoryViewState {
    fn default() -> Self {
        Self {
            search_query: String::new(),
            filter: MemoryFilter::All,
            editing_note: None,
            show_new_note_dialog: false,
            new_note_title: String::new(),
            new_note_content: String::new(),
            new_note_is_pinned: true,
        }
    }
}

/// Render the Memory and Notes Management View
pub fn render_memory_view(
    ui: &mut Ui,
    notes: &mut Vec<MemoryNote>,
    view_state: &mut MemoryViewState,
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
                        egui::RichText::new("Memory")
                            .strong()
                            .size(13.0)
                            .color(COLOR_INK),
                    );

                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.horizontal(|ui| {
                            local_dot(ui);
                            ui.label(
                                egui::RichText::new("SQLite FTS5 Local Index")
                                    .size(12.5)
                                    .color(COLOR_INK2),
                            );
                        });
                    });
                });
            });

        // Main Content Area
        egui::ScrollArea::vertical()
            .id_salt("memory_view_scroll")
            .show(ui, |ui| {
                ui.add_space(24.0);

                let max_width = 720.0;
                ui.vertical_centered(|ui| {
                    ui.set_width(ui.available_width().min(max_width));

                    // Title Header + Create Note Action
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.label(
                                egui::RichText::new("Local Memory & Notes")
                                    .strong()
                                    .size(24.0)
                                    .color(COLOR_INK),
                            );
                            ui.add_space(2.0);
                            ui.label(
                                egui::RichText::new("Explicit rules and retrieved excerpts indexed via SQLite FTS5. All deletions are permanent.")
                                    .size(13.0)
                                    .color(COLOR_MUTE),
                            );
                        });

                        ui.with_layout(Layout::right_to_left(Align::Min), |ui| {
                            let btn = ui.add(
                                egui::Button::new(
                                    egui::RichText::new("+ New Note")
                                        .strong()
                                        .color(COLOR_WHITE),
                                )
                                .fill(COLOR_BLUE)
                                .rounding(Rounding::same(6.0))
                                .min_size(vec2(100.0, 32.0)),
                            );
                            if btn.clicked() {
                                view_state.show_new_note_dialog = true;
                            }
                        });
                    });

                    ui.add_space(16.0);

                    // Search and Filter Bar Card
                    egui::Frame::none()
                        .fill(COLOR_WHITE)
                        .stroke(Stroke::new(1.0_f32, COLOR_LINE))
                        .rounding(Rounding::same(8.0))
                        .inner_margin(egui::Margin::same(12.0))
                        .show(ui, |ui| {
                            ui.horizontal(|ui| {
                                let search_edit = egui::TextEdit::singleline(&mut view_state.search_query)
                                    .hint_text("🔍 Search notes and memory by keyword (FTS5)...")
                                    .desired_width(ui.available_width());
                                ui.add(search_edit);
                            });

                            ui.add_space(8.0);

                            // Filter Chips
                            ui.horizontal(|ui| {
                                render_filter_chip(ui, &mut view_state.filter, MemoryFilter::All, "All");
                                render_filter_chip(ui, &mut view_state.filter, MemoryFilter::Pinned, "📌 Pinned");
                                render_filter_chip(ui, &mut view_state.filter, MemoryFilter::InPrompt, "⚡ In Active Prompt");
                                render_filter_chip(ui, &mut view_state.filter, MemoryFilter::AutoExtracted, "📝 Summaries");
                            });
                        });

                    ui.add_space(18.0);

                    // Notes List
                    let query = view_state.search_query.trim().to_lowercase();
                    let mut note_to_delete: Option<usize> = None;

                    for (idx, note) in notes.iter_mut().enumerate() {
                        // Apply filters
                        match view_state.filter {
                            MemoryFilter::All => {}
                            MemoryFilter::Pinned => {
                                if !note.is_pinned {
                                    continue;
                                }
                            }
                            MemoryFilter::InPrompt => {
                                if !note.is_in_active_prompt {
                                    continue;
                                }
                            }
                            MemoryFilter::AutoExtracted => {
                                if !note.is_auto_extracted {
                                    continue;
                                }
                            }
                        }

                        // Apply search query
                        if !query.is_empty() {
                            let match_title = note.title.to_lowercase().contains(&query);
                            let match_content = note.excerpt.to_lowercase().contains(&query);
                            let match_src = note.source_reference.to_lowercase().contains(&query);
                            if !match_title && !match_content && !match_src {
                                continue;
                            }
                        }

                        // Render Note Card
                        egui::Frame::none()
                            .fill(COLOR_WHITE)
                            .stroke(Stroke::new(1.0_f32, COLOR_LINE))
                            .rounding(Rounding::same(8.0))
                            .inner_margin(egui::Margin::same(14.0))
                            .show(ui, |ui| {
                                ui.horizontal(|ui| {
                                    ui.vertical(|ui| {
                                        ui.horizontal(|ui| {
                                            ui.label(
                                                egui::RichText::new(&note.title)
                                                    .strong()
                                                    .size(15.0)
                                                    .color(COLOR_INK),
                                            );

                                            if note.is_pinned {
                                                render_badge(ui, "PINNED", COLOR_INK);
                                            }
                                            if note.is_in_active_prompt {
                                                render_badge(ui, "IN PROMPT", COLOR_BLUE2);
                                            }
                                            if note.is_auto_extracted {
                                                render_badge(ui, "SUMMARY", COLOR_MUTE);
                                            }
                                        });

                                        ui.add_space(4.0);

                                        ui.label(
                                            egui::RichText::new(&note.excerpt)
                                                .size(13.5)
                                                .color(COLOR_INK),
                                        );

                                        ui.add_space(6.0);

                                        ui.horizontal(|ui| {
                                            ui.label(
                                                egui::RichText::new(format!("Source: {}", note.source_reference))
                                                    .size(11.5)
                                                    .color(COLOR_MUTE),
                                            );
                                            ui.label(
                                                egui::RichText::new(format!("· Added: {}", note.created_at))
                                                    .size(11.5)
                                                    .color(COLOR_MUTE),
                                            );
                                        });
                                    });

                                    ui.with_layout(Layout::right_to_left(Align::Min), |ui| {
                                        // Delete Button
                                        if ui
                                            .button(
                                                egui::RichText::new("Delete")
                                                    .size(12.0)
                                                    .color(egui::Color32::from_rgb(0xD9, 0x38, 0x3A)),
                                            )
                                            .on_hover_text("Permanently remove from local database & FTS5 search index")
                                            .clicked()
                                        {
                                            note_to_delete = Some(idx);
                                        }

                                        // Edit Button
                                        if ui
                                            .button(egui::RichText::new("Edit").size(12.0).color(COLOR_INK2))
                                            .clicked()
                                        {
                                            view_state.editing_note = Some(note.clone());
                                        }

                                        // Pin / Unpin Toggle
                                        let pin_label = if note.is_pinned { "Unpin" } else { "Pin" };
                                        if ui
                                            .button(egui::RichText::new(pin_label).size(12.0).color(COLOR_BLUE))
                                            .clicked()
                                        {
                                            note.is_pinned = !note.is_pinned;
                                        }
                                    });
                                });
                            });

                        ui.add_space(10.0);
                    }

                    if let Some(to_del) = note_to_delete {
                        notes.remove(to_del);
                    }
                });
            });

        // Edit Note Modal
        if let Some(mut edit_note) = view_state.editing_note.clone() {
            let mut is_open = true;
            egui::Window::new("Edit Memory Note")
                .open(&mut is_open)
                .resizable(false)
                .default_size(vec2(440.0, 300.0))
                .anchor(Align2::CENTER_CENTER, vec2(0.0, 0.0))
                .show(ui.ctx(), |ui| {
                    ui.label("Title:");
                    ui.text_edit_singleline(&mut edit_note.title);
                    ui.add_space(8.0);

                    ui.label("Content / Excerpt:");
                    ui.add(egui::TextEdit::multiline(&mut edit_note.excerpt).desired_rows(4));
                    ui.add_space(8.0);

                    ui.checkbox(&mut edit_note.is_pinned, "Pinned rule");
                    ui.add_space(12.0);

                    ui.horizontal(|ui| {
                        if ui.button("Save Changes").clicked() {
                            if let Some(existing) = notes.iter_mut().find(|n| n.id == edit_note.id) {
                                *existing = edit_note;
                            }
                            view_state.editing_note = None;
                        }
                        if ui.button("Cancel").clicked() {
                            view_state.editing_note = None;
                        }
                    });
                });
            if !is_open {
                view_state.editing_note = None;
            }
        }

        // New Note Dialog Modal
        if view_state.show_new_note_dialog {
            let mut is_open = true;
            egui::Window::new("Add Memory Note or Project Rule")
                .open(&mut is_open)
                .resizable(false)
                .default_size(vec2(440.0, 300.0))
                .anchor(Align2::CENTER_CENTER, vec2(0.0, 0.0))
                .show(ui.ctx(), |ui| {
                    ui.label("Title:");
                    ui.text_edit_singleline(&mut view_state.new_note_title);
                    ui.add_space(8.0);

                    ui.label("Content / Rule Excerpt:");
                    ui.add(egui::TextEdit::multiline(&mut view_state.new_note_content).desired_rows(4));
                    ui.add_space(8.0);

                    ui.checkbox(&mut view_state.new_note_is_pinned, "Pinned project rule (always included)");
                    ui.add_space(12.0);

                    ui.horizontal(|ui| {
                        let create_btn = ui.add(
                            egui::Button::new(
                                egui::RichText::new("Create Note")
                                    .strong()
                                    .color(COLOR_WHITE),
                            )
                            .fill(COLOR_BLUE),
                        );
                        if create_btn.clicked() {
                            let title = view_state.new_note_title.trim().to_string();
                            let content = view_state.new_note_content.trim().to_string();
                            if !content.is_empty() {
                                notes.push(MemoryNote {
                                    id: format!("note_{}", notes.len() + 1),
                                    title: if title.is_empty() { "Custom Note".into() } else { title },
                                    excerpt: content,
                                    source_reference: "User created".into(),
                                    is_pinned: view_state.new_note_is_pinned,
                                    is_auto_extracted: false,
                                    is_in_active_prompt: view_state.new_note_is_pinned,
                                    created_at: "Just now".into(),
                                });
                                view_state.new_note_title.clear();
                                view_state.new_note_content.clear();
                                view_state.show_new_note_dialog = false;
                            }
                        }

                        if ui.button("Cancel").clicked() {
                            view_state.show_new_note_dialog = false;
                        }
                    });
                });
            if !is_open {
                view_state.show_new_note_dialog = false;
            }
        }
    });
}

fn render_filter_chip(
    ui: &mut Ui,
    current_filter: &mut MemoryFilter,
    filter: MemoryFilter,
    label: &str,
) {
    let is_selected = *current_filter == filter;
    let bg = if is_selected { COLOR_INK } else { COLOR_SIDE };
    let fg = if is_selected { COLOR_WHITE } else { COLOR_INK2 };

    let btn = ui.add(
        egui::Button::new(egui::RichText::new(label).size(12.0).color(fg))
            .fill(bg)
            .rounding(Rounding::same(6.0)),
    );

    if btn.clicked() {
        *current_filter = filter;
    }
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
