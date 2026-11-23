use egui::{
    vec2, Align, Color32, Layout, Pos2, Rect, Rounding, Stroke, Ui,
};
use crate::app::state::{ChatMessage, ContextSegmentKey, MessageRole, ModelProfile, Session};
use crate::ui::components::{format_number, local_dot, render_context_strip};
use crate::ui::theme::*;

pub struct ChatActionResponse {
    pub send_message: Option<String>,
    pub stop_generation: bool,
    pub new_session_requested: bool,
    pub open_sources_modal: Option<Vec<String>>,
    pub save_as_note: Option<String>,
}

impl Default for ChatActionResponse {
    fn default() -> Self {
        Self {
            send_message: None,
            stop_generation: false,
            new_session_requested: false,
            open_sources_modal: None,
            save_as_note: None,
        }
    }
}

/// Render the Central Chat Workspace
pub fn render_chat_view(
    ui: &mut Ui,
    session: &mut Session,
    models: &[ModelProfile],
    active_model_id: &mut String,
    backend_label: &str,
    composer_text: &mut String,
    memory_retrieval_enabled: &mut bool,
    is_generating: bool,
    hovered_segment: &mut Option<ContextSegmentKey>,
) -> ChatActionResponse {
    let mut action_resp = ChatActionResponse::default();

    ui.vertical(|ui| {
        // Top Header Bar (56px)
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
                        egui::RichText::new("Chat")
                            .strong()
                            .size(13.0)
                            .color(COLOR_INK),
                    );

                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        // Active Model Selector
                        let active_model_name = models
                            .iter()
                            .find(|m| m.id == *active_model_id)
                            .map(|m| m.name.as_str())
                            .unwrap_or("Select Model");

                        egui::ComboBox::from_id_salt("top_active_model_dropdown")
                            .selected_text(
                                egui::RichText::new(format!("{} ▾", active_model_name))
                                    .strong()
                                    .size(13.0)
                                    .color(COLOR_INK),
                            )
                            .show_ui(ui, |ui| {
                                for m in models {
                                    if ui.selectable_value(active_model_id, m.id.clone(), &m.name).clicked() {
                                        // Model changed
                                    }
                                }
                            });

                        ui.add_space(14.0);

                        // Active backend pill
                        egui::Frame::none()
                            .fill(COLOR_PANEL)
                            .stroke(Stroke::new(1.0_f32, COLOR_LINE))
                            .rounding(Rounding::same(6.0))
                            .inner_margin(egui::Margin::symmetric(8.0, 4.0))
                            .show(ui, |ui| {
                                ui.horizontal(|ui| {
                                    local_dot(ui);
                                    ui.label(
                                        egui::RichText::new(backend_label)
                                            .strong()
                                            .size(11.5)
                                            .color(COLOR_INK2),
                                    );
                                });
                            });

                        ui.add_space(14.0);

                        // Local only status indicator
                        ui.horizontal(|ui| {
                            local_dot(ui);
                            ui.label(
                                egui::RichText::new("Offline, local only")
                                    .size(12.5)
                                    .color(COLOR_INK2),
                            );
                        });
                    });
                });
            });

        // Chat Transcript Scroll Area
        let composer_height = 140.0;
        let available_height = (ui.available_height() - composer_height).max(200.0);

        egui::ScrollArea::vertical()
            .id_salt("chat_messages_scroll")
            .auto_shrink([false, false])
            .max_height(available_height)
            .show(ui, |ui| {
                ui.add_space(20.0);

                // Center column constraint (max-width 660px)
                let col_width = ui.available_width().min(660.0);
                ui.vertical_centered(|ui| {
                    ui.set_width(col_width);

                    // Session Title Header
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.label(
                                egui::RichText::new(&session.title)
                                    .strong()
                                    .size(24.0)
                                    .color(COLOR_INK),
                            );
                            ui.add_space(2.0);
                            ui.label(
                                egui::RichText::new(&session.subtitle)
                                    .size(13.0)
                                    .color(COLOR_MUTE),
                            );
                        });

                        ui.with_layout(Layout::right_to_left(Align::Min), |ui| {
                            if ui
                                .button(
                                    egui::RichText::new("New session")
                                        .size(13.0)
                                        .color(COLOR_INK2),
                                )
                                .on_hover_text("Start a fresh session with clean context")
                                .clicked()
                            {
                                action_resp.new_session_requested = true;
                            }
                        });
                    });

                    ui.add_space(28.0);

                    // Message history
                    for msg in &session.messages {
                        render_chat_message(
                            ui,
                            msg,
                            hovered_segment,
                            &mut action_resp,
                        );
                        ui.add_space(24.0);
                    }
                });
            });

        // Bottom Composer Card
        ui.with_layout(Layout::bottom_up(Align::Center), |ui| {
            ui.add_space(16.0);
            let box_width = ui.available_width().min(660.0);
            ui.set_width(box_width);

            egui::Frame::none()
                .fill(COLOR_WHITE)
                .stroke(Stroke::new(1.0_f32, COLOR_INK))
                .rounding(Rounding::same(12.0))
                .inner_margin(egui::Margin::symmetric(16.0, 12.0))
                .show(ui, |ui| {
                    ui.vertical(|ui| {
                        let placeholder = "Message local model. Nothing leaves this device.";
                        let text_edit = egui::TextEdit::multiline(composer_text)
                            .hint_text(egui::RichText::new(placeholder).color(COLOR_MUTE).size(14.5))
                            .desired_rows(2)
                            .desired_width(box_width - 32.0)
                            .frame(false);

                        let text_response = ui.add(text_edit);

                        // Enter to send (Shift+Enter for newline)
                        if text_response.has_focus()
                            && ui.input(|i| i.key_pressed(egui::Key::Enter) && !i.modifiers.shift)
                        {
                            let trimmed = composer_text.trim();
                            if !trimmed.is_empty() && !is_generating {
                                action_resp.send_message = Some(trimmed.to_string());
                                composer_text.clear();
                            }
                        }

                        ui.add_space(8.0);

                        // Composer Action Bar
                        ui.horizontal(|ui| {
                            // File attachment stub
                            if ui
                                .button(egui::RichText::new("📎 Attach local file").size(12.5).color(COLOR_INK2))
                                .on_hover_text("Select local text file to inject directly into context")
                                .clicked()
                            {
                                // Attach file stub
                            }

                            ui.add_space(8.0);

                            // Memory toggle button
                            let mem_label = if *memory_retrieval_enabled {
                                "🧠 Memory on"
                            } else {
                                "🧠 Memory off"
                            };
                            let mem_color = if *memory_retrieval_enabled {
                                COLOR_BLUE
                            } else {
                                COLOR_MUTE
                            };

                            if ui
                                .button(egui::RichText::new(mem_label).size(12.5).color(mem_color))
                                .on_hover_text("Toggle automatic FTS5 memory retrieval for next prompt")
                                .clicked()
                            {
                                *memory_retrieval_enabled = !*memory_retrieval_enabled;
                            }

                            ui.add_space(8.0);
                            ui.label(
                                egui::RichText::new("Enter to send")
                                    .size(11.5)
                                    .color(COLOR_MUTE),
                            );

                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                if is_generating {
                                    let stop_btn = ui.add(
                                        egui::Button::new(
                                            egui::RichText::new("■ Stop")
                                                .strong()
                                                .size(13.0)
                                                .color(COLOR_WHITE),
                                        )
                                        .fill(Color32::from_rgb(0xD9, 0x38, 0x3A))
                                        .rounding(Rounding::same(8.0)),
                                    );
                                    if stop_btn.clicked() {
                                        action_resp.stop_generation = true;
                                    }
                                } else {
                                    let send_btn = ui.add(
                                        egui::Button::new(
                                            egui::RichText::new("Send")
                                                .strong()
                                                .size(13.0)
                                                .color(COLOR_WHITE),
                                        )
                                        .fill(COLOR_BLUE)
                                        .rounding(Rounding::same(8.0)),
                                    );
                                    if send_btn.clicked() {
                                        let trimmed = composer_text.trim();
                                        if !trimmed.is_empty() {
                                            action_resp.send_message = Some(trimmed.to_string());
                                            composer_text.clear();
                                        }
                                    }
                                }
                            });
                        });
                    });
                });
        });
    });

    action_resp
}

fn render_chat_message(
    ui: &mut Ui,
    msg: &ChatMessage,
    hovered_segment: &mut Option<ContextSegmentKey>,
    action_resp: &mut ChatActionResponse,
) {
    ui.vertical(|ui| {
        // Author header
        ui.horizontal(|ui| {
            ui.label(
                egui::RichText::new(&msg.author_name)
                    .strong()
                    .size(13.0)
                    .color(COLOR_INK),
            );
            let sub_info = match &msg.model_info {
                Some(info) => format!("{} · {}", msg.time_str, info),
                None => msg.time_str.clone(),
            };
            ui.label(
                egui::RichText::new(sub_info)
                    .size(12.0)
                    .color(COLOR_MUTE),
            );
        });

        ui.add_space(4.0);

        match msg.role {
            MessageRole::User => {
                // User Message: Yellow accent bar on left (#F2D452)
                egui::Frame::none()
                    .inner_margin(egui::Margin {
                        left: 16.0,
                        right: 8.0,
                        top: 2.0,
                        bottom: 4.0,
                    })
                    .show(ui, |ui| {
                        // Draw left vertical bar
                        let start_pos = ui.cursor().min;
                        let line_rect = Rect::from_min_size(
                            Pos2::new(start_pos.x - 16.0, start_pos.y),
                            vec2(3.0, 24.0),
                        );
                        ui.painter().rect_filled(line_rect, Rounding::same(1.0), COLOR_HL);

                        ui.label(
                            egui::RichText::new(&msg.content)
                                .size(15.0)
                                .color(COLOR_INK),
                        );
                    });
            }
            MessageRole::Assistant => {
                // Assistant Message: Editorial typography with divider and callouts
                egui::Frame::none()
                    .inner_margin(egui::Margin {
                        left: 0.0,
                        right: 0.0,
                        top: 4.0,
                        bottom: 4.0,
                    })
                    .show(ui, |ui| {
                        if msg.content.is_empty() {
                            ui.label(
                                egui::RichText::new("Thinking / streaming response...")
                                    .italics()
                                    .size(14.0)
                                    .color(COLOR_MUTE),
                            );
                        } else {
                            for paragraph in msg.content.split("\n\n") {
                                ui.label(
                                    egui::RichText::new(paragraph)
                                        .size(15.5)
                                        .color(Color32::from_rgb(0x1D, 0x23, 0x30)),
                                );
                                ui.add_space(6.0);
                            }
                        }

                        // Aside callout note if present
                        if let Some(aside) = &msg.aside {
                            ui.add_space(8.0);
                            egui::Frame::none()
                                .inner_margin(egui::Margin {
                                    left: 14.0,
                                    right: 8.0,
                                    top: 4.0,
                                    bottom: 4.0,
                                })
                                .show(ui, |ui| {
                                    let start_pos = ui.cursor().min;
                                    let line_rect = Rect::from_min_size(
                                        Pos2::new(start_pos.x - 14.0, start_pos.y),
                                        vec2(1.5, 20.0),
                                    );
                                    ui.painter().rect_filled(line_rect, Rounding::ZERO, COLOR_GREY);

                                    ui.label(
                                        egui::RichText::new(aside)
                                            .italics()
                                            .size(13.5)
                                            .color(COLOR_INK2),
                                    );
                                });
                            ui.add_space(8.0);
                        }

                        // Action buttons: Copy, View sources, Save as note
                        ui.horizontal(|ui| {
                            if ui
                                .button(egui::RichText::new("Copy").size(12.5).color(COLOR_MUTE))
                                .on_hover_text("Copy response text to clipboard")
                                .clicked()
                            {
                                ui.output_mut(|o| o.copied_text = msg.content.clone());
                            }

                            if !msg.sources.is_empty() {
                                if ui
                                    .button(egui::RichText::new("View sources").size(12.5).color(COLOR_MUTE))
                                    .on_hover_text("Inspect retrieved notes and turn sources")
                                    .clicked()
                                {
                                    action_resp.open_sources_modal = Some(msg.sources.clone());
                                }
                            }

                            if ui
                                .button(egui::RichText::new("Save as note").size(12.5).color(COLOR_MUTE))
                                .on_hover_text("Save this response or excerpt as persistent memory")
                                .clicked()
                            {
                                action_resp.save_as_note = Some(msg.content.clone());
                            }
                        });

                        // Per-turn context strip
                        if let Some(budget) = &msg.turn_budget {
                            ui.add_space(16.0);
                            ui.vertical(|ui| {
                                ui.horizontal(|ui| {
                                    ui.label(
                                        egui::RichText::new("Context used for this reply")
                                            .strong()
                                            .size(12.5)
                                            .color(COLOR_INK),
                                    );
                                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                        let count_str = format!(
                                            "{} of {} tokens",
                                            format_number(budget.packed_tokens()),
                                            format_number(budget.total_limit)
                                        );
                                        ui.label(
                                            egui::RichText::new(count_str)
                                                .size(12.0)
                                                .color(COLOR_MUTE),
                                        );
                                    });
                                });

                                ui.add_space(6.0);
                                render_context_strip(ui, budget, hovered_segment);
                            });
                        }
                    });
            }
            MessageRole::System => {
                ui.label(
                    egui::RichText::new(&msg.content)
                        .italics()
                        .size(12.5)
                        .color(COLOR_MUTE),
                );
            }
        }
    });
}
