use egui::{vec2, Align, Align2, Layout, Pos2, Rect, Rounding, Sense, Stroke, Ui};
use crate::app::state::{NavigationTab, Session};
use crate::ui::components::local_dot;
use crate::ui::theme::*;

/// Render the Left Navigation Bar (216px width)
pub fn render_nav(
    ui: &mut Ui,
    current_tab: &mut NavigationTab,
    sessions: &[Session],
    active_session_id: &mut String,
    on_new_session: &mut bool,
) {
    let side_width = 216.0;
    ui.set_width(side_width);

    egui::Frame::none()
        .fill(COLOR_SIDE)
        .stroke(Stroke::new(1.0_f32, COLOR_LINE))
        .inner_margin(egui::Margin {
            left: 14.0,
            right: 14.0,
            top: 22.0,
            bottom: 16.0,
        })
        .show(ui, |ui| {
            // Brand header
            ui.horizontal(|ui| {
                // LowCon logo icon
                let (logo_rect, _) = ui.allocate_exact_size(vec2(26.0, 26.0), Sense::hover());
                let painter = ui.painter_at(logo_rect);
                painter.rect_stroke(
                    logo_rect.shrink(1.0),
                    Rounding::same(5.0),
                    Stroke::new(2.0_f32, COLOR_INK),
                );
                // Vertical blue dividing bar
                painter.line_segment(
                    [
                        Pos2::new(logo_rect.min.x + 8.0, logo_rect.min.y + 1.0),
                        Pos2::new(logo_rect.min.x + 8.0, logo_rect.max.y - 1.0),
                    ],
                    Stroke::new(2.0_f32, COLOR_BLUE),
                );
                // Horizontal lines representing packed context
                painter.line_segment(
                    [
                        Pos2::new(logo_rect.min.x + 12.0, logo_rect.min.y + 8.0),
                        Pos2::new(logo_rect.max.x - 5.0, logo_rect.min.y + 8.0),
                    ],
                    Stroke::new(2.0_f32, COLOR_INK),
                );
                painter.line_segment(
                    [
                        Pos2::new(logo_rect.min.x + 12.0, logo_rect.min.y + 13.0),
                        Pos2::new(logo_rect.max.x - 5.0, logo_rect.min.y + 13.0),
                    ],
                    Stroke::new(2.0_f32, COLOR_INK),
                );
                painter.line_segment(
                    [
                        Pos2::new(logo_rect.min.x + 12.0, logo_rect.min.y + 18.0),
                        Pos2::new(logo_rect.max.x - 9.0, logo_rect.min.y + 18.0),
                    ],
                    Stroke::new(2.0_f32, COLOR_INK),
                );

                ui.vertical(|ui| {
                    ui.label(
                        egui::RichText::new("LowCon")
                            .strong()
                            .size(19.0)
                            .color(COLOR_INK),
                    );
                    ui.label(
                        egui::RichText::new("Local model workbench")
                            .size(11.5)
                            .color(COLOR_MUTE),
                    );
                });
            });

            ui.add_space(20.0);

            // Primary Navigation Tabs
            render_tab_button(ui, current_tab, NavigationTab::Chat, "Chat", Some(sessions.len()));
            render_tab_button(ui, current_tab, NavigationTab::Models, "Models", None);
            render_tab_button(ui, current_tab, NavigationTab::Memory, "Memory", None);
            render_tab_button(ui, current_tab, NavigationTab::Settings, "Settings", None);

            ui.add_space(24.0);

            // Recent Sessions Section Header
            ui.horizontal(|ui| {
                ui.label(
                    egui::RichText::new("RECENT SESSIONS")
                        .size(11.0)
                        .strong()
                        .color(COLOR_MUTE),
                );
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if ui
                        .button(egui::RichText::new("+").size(14.0).color(COLOR_INK2))
                        .on_hover_text("Start new chat session")
                        .clicked()
                    {
                        *on_new_session = true;
                    }
                });
            });

            ui.add_space(6.0);

            // Sessions List
            egui::ScrollArea::vertical()
                .id_salt("nav_sessions_scroll")
                .max_height(260.0)
                .show(ui, |ui| {
                    for session in sessions {
                        let is_active = session.id == *active_session_id && *current_tab == NavigationTab::Chat;
                        let text_color = if is_active { COLOR_INK } else { COLOR_INK2 };
                        let bg_color = if is_active { COLOR_WHITE } else { COLOR_SIDE };

                        let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width(), 32.0), Sense::click());
                        if response.clicked() {
                            *active_session_id = session.id.clone();
                            *current_tab = NavigationTab::Chat;
                        }

                        let painter = ui.painter_at(rect);
                        if is_active {
                            painter.rect_filled(rect, Rounding::same(6.0), bg_color);
                            // Left active blue bar
                            let bar_rect = Rect::from_min_size(rect.min, vec2(3.0, rect.height()));
                            painter.rect_filled(bar_rect, Rounding::same(1.0), COLOR_BLUE);
                        } else if response.hovered() {
                            painter.rect_filled(rect, Rounding::same(6.0), COLOR_HOVER);
                        }

                        let label_pos = Pos2::new(rect.min.x + 10.0, rect.min.y + 8.0);
                        let truncated_title = if session.title.len() > 24 {
                            format!("{}...", &session.title[..21])
                        } else {
                            session.title.clone()
                        };

                        painter.text(
                            label_pos,
                            Align2::LEFT_TOP,
                            truncated_title,
                            egui::FontId::proportional(13.0),
                            text_color,
                        );
                    }
                });

            // Bottom Local Boundary Badge
            ui.with_layout(Layout::bottom_up(Align::Min), |ui| {
                ui.add_space(8.0);
                egui::Frame::none()
                    .stroke(Stroke::new(1.0_f32, COLOR_LINE))
                    .inner_margin(egui::Margin::symmetric(0.0, 10.0))
                    .show(ui, |ui| {
                        ui.horizontal(|ui| {
                            local_dot(ui);
                            ui.label(
                                egui::RichText::new("Local boundary active")
                                    .strong()
                                    .size(12.5)
                                    .color(COLOR_INK),
                            );
                        });
                        ui.add_space(2.0);
                        ui.label(
                            egui::RichText::new("No cloud, telemetry or remote calls. Prompts and memory stay on this device.")
                                .size(11.0)
                                .color(COLOR_INK2),
                        );
                    });
            });
        });
}

fn render_tab_button(
    ui: &mut Ui,
    current_tab: &mut NavigationTab,
    tab: NavigationTab,
    title: &str,
    badge_count: Option<usize>,
) {
    let is_selected = *current_tab == tab;
    let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width(), 34.0), Sense::click());
    if response.clicked() {
        *current_tab = tab;
    }

    let painter = ui.painter_at(rect);
    let bg_color = if is_selected {
        COLOR_INK
    } else if response.hovered() {
        COLOR_HOVER
    } else {
        COLOR_SIDE
    };

    let text_color = if is_selected { COLOR_WHITE } else { COLOR_INK2 };
    let badge_color = if is_selected {
        egui::Color32::from_rgb(0xAE, 0xB6, 0xC6)
    } else {
        COLOR_MUTE
    };

    painter.rect_filled(rect, Rounding::same(6.0), bg_color);

    let text_pos = Pos2::new(rect.min.x + 10.0, rect.min.y + 8.0);
    painter.text(
        text_pos,
        Align2::LEFT_TOP,
        title,
        egui::FontId::proportional(14.0),
        text_color,
    );

    if let Some(count) = badge_count {
        let badge_pos = Pos2::new(rect.max.x - 12.0, rect.min.y + 8.0);
        painter.text(
            badge_pos,
            Align2::RIGHT_TOP,
            count.to_string(),
            egui::FontId::proportional(12.5),
            badge_color,
        );
    }
}
