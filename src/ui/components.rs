use egui::{
    vec2, Color32, Pos2, Rect, Response, Rounding, Sense, Stroke, Ui,
};
use crate::app::state::{ContextSegment, ContextSegmentKey, TurnContextBudget};
use crate::ui::theme::*;

/// Render the horizontal segmented context strip used inside assistant message turns
pub fn render_context_strip(ui: &mut Ui, budget: &TurnContextBudget, hovered_key: &mut Option<ContextSegmentKey>) {
    let height = 10.0;
    let available_width = ui.available_width().min(660.0);
    let (rect, _response) = ui.allocate_exact_size(vec2(available_width, height), Sense::hover());

    let painter = ui.painter_at(rect);
    let total_tokens = budget.total_limit.max(1) as f32;
    let gap = 2.0;
    let num_segs = budget.segments.len();
    let total_gaps = if num_segs > 1 { (num_segs - 1) as f32 * gap } else { 0.0 };
    let usable_width = (rect.width() - total_gaps).max(1.0);

    let mut current_x = rect.min.x;
    for segment in &budget.segments {
        let seg_width = ((segment.tokens as f32 / total_tokens) * usable_width).max(2.0);
        let seg_rect = Rect::from_min_size(Pos2::new(current_x, rect.min.y), vec2(seg_width, height));

        let is_hovered = *hovered_key == Some(segment.key);
        let fill = if segment.is_free {
            Color32::TRANSPARENT
        } else if is_hovered {
            segment.color
        } else if hovered_key.is_some() {
            segment.color.linear_multiply(0.3)
        } else {
            segment.color
        };

        if segment.is_free {
            painter.rect_stroke(
                seg_rect,
                Rounding::same(2.0),
                Stroke::new(1.5_f32, COLOR_GREY),
            );
        } else {
            painter.rect_filled(seg_rect, Rounding::same(2.0), fill);
        }

        // Segment tooltip interaction
        if ui.rect_contains_pointer(seg_rect) {
            *hovered_key = Some(segment.key);
            egui::show_tooltip(ui.ctx(), ui.layer_id(), egui::Id::new(segment.key), |ui| {
                ui.horizontal(|ui| {
                    let (swatch, _) = ui.allocate_exact_size(vec2(10.0, 10.0), Sense::hover());
                    ui.painter().rect_filled(swatch, Rounding::same(2.0), segment.color);
                    ui.strong(&segment.name);
                });
                ui.label(&segment.description);
                ui.label(format!("Tokens: {} ({:.1}%)", segment.tokens, (segment.tokens as f32 / total_tokens) * 100.0));
            });
        }

        current_x += seg_width + gap;
    }
}

/// Render the vertical context budget meter stack (44px wide)
pub fn render_vertical_context_stack(
    ui: &mut Ui,
    budget: &TurnContextBudget,
    height: f32,
    hovered_key: &mut Option<ContextSegmentKey>,
) {
    let width = 44.0;
    let (rect, _response) = ui.allocate_exact_size(vec2(width, height), Sense::hover());
    let painter = ui.painter_at(rect);

    let total_tokens = budget.total_limit.max(1) as f32;
    let gap = 2.0;
    let num_segs = budget.segments.len();
    let total_gaps = if num_segs > 1 { (num_segs - 1) as f32 * gap } else { 0.0 };
    let usable_height = (rect.height() - total_gaps).max(1.0);

    let mut current_y = rect.min.y;
    for segment in &budget.segments {
        let seg_height = ((segment.tokens as f32 / total_tokens) * usable_height).max(4.0);
        let seg_rect = Rect::from_min_size(Pos2::new(rect.min.x, current_y), vec2(width, seg_height));

        let is_hovered = *hovered_key == Some(segment.key);
        let fill = if segment.is_free {
            Color32::TRANSPARENT
        } else if is_hovered {
            segment.color
        } else if hovered_key.is_some() {
            segment.color.linear_multiply(0.25)
        } else {
            segment.color
        };

        if segment.is_free {
            painter.rect_stroke(
                seg_rect,
                Rounding::same(3.0),
                Stroke::new(1.5_f32, COLOR_GREY),
            );
        } else {
            painter.rect_filled(seg_rect, Rounding::same(3.0), fill);
        }

        if ui.rect_contains_pointer(seg_rect) {
            *hovered_key = Some(segment.key);
            egui::show_tooltip(ui.ctx(), ui.layer_id(), egui::Id::new((segment.key, "v")), |ui| {
                ui.strong(&segment.name);
                ui.label(&segment.description);
                ui.label(format!("{} tokens", segment.tokens));
            });
        }

        current_y += seg_height + gap;
    }
}

/// Render a single context row breakdown item with synchronized hover highlight
pub fn render_context_row(
    ui: &mut Ui,
    segment: &ContextSegment,
    hovered_key: &mut Option<ContextSegmentKey>,
) -> Response {
    let is_hovered = *hovered_key == Some(segment.key);
    let row_bg = if is_hovered {
        Color32::from_rgba_premultiplied(255, 255, 255, 180)
    } else {
        Color32::TRANSPARENT
    };

    let frame = egui::Frame::none()
        .fill(row_bg)
        .rounding(Rounding::same(4.0))
        .inner_margin(egui::Margin::symmetric(6.0, 4.0));

    let response = frame
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                // Color swatch
                let (swatch, _) = ui.allocate_exact_size(vec2(8.0, 8.0), Sense::hover());
                if segment.is_free {
                    ui.painter().rect_stroke(swatch, Rounding::same(1.0), Stroke::new(1.0_f32, COLOR_GREY));
                } else {
                    ui.painter().rect_filled(swatch, Rounding::same(1.0), segment.color);
                }

                ui.vertical(|ui| {
                    ui.label(
                        egui::RichText::new(&segment.name)
                            .strong()
                            .size(13.0)
                            .color(COLOR_INK),
                    );
                    ui.label(
                        egui::RichText::new(&segment.description)
                            .size(11.5)
                            .color(COLOR_MUTE),
                    );
                });

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let token_text = format_number(segment.tokens);
                    let color = if segment.is_free { COLOR_GREEN } else { COLOR_INK2 };
                    ui.label(
                        egui::RichText::new(token_text)
                            .strong()
                            .size(13.0)
                            .color(color),
                    );
                });
            });
        })
        .response;

    if response.hovered() {
        *hovered_key = Some(segment.key);
    }

    // Border line at the bottom
    let line_rect = Rect::from_min_size(
        Pos2::new(response.rect.min.x, response.rect.max.y),
        vec2(response.rect.width(), 1.0),
    );
    ui.painter().rect_filled(line_rect, Rounding::ZERO, COLOR_LINE);

    response
}

/// Render a clean iOS/modern style toggle switch
pub fn toggle_switch(ui: &mut Ui, on: &mut bool) -> Response {
    let desired_size = vec2(36.0, 20.0);
    let (rect, mut response) = ui.allocate_exact_size(desired_size, Sense::click());
    if response.clicked() {
        *on = !*on;
        response.mark_changed();
    }

    if ui.is_rect_visible(rect) {
        let how_on = ui.ctx().animate_bool(response.id, *on);
        let bg_color = Color32::from_rgb(
            lerp(COLOR_GREY.r() as f32, COLOR_BLUE.r() as f32, how_on) as u8,
            lerp(COLOR_GREY.g() as f32, COLOR_BLUE.g() as f32, how_on) as u8,
            lerp(COLOR_GREY.b() as f32, COLOR_BLUE.b() as f32, how_on) as u8,
        );

        let corner_radius = rect.height() / 2.0;
        ui.painter().rect_filled(rect, Rounding::same(corner_radius), bg_color);

        let circle_x = lerp(rect.min.x + 2.0 + 8.0, rect.max.x - 2.0 - 8.0, how_on);
        let center = Pos2::new(circle_x, rect.center().y);
        let radius = 7.5;
        ui.painter().circle_filled(center, radius, COLOR_WHITE);
    }

    response
}

/// Helper for linear interpolation
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// Format integer with commas, e.g. 4,160
pub fn format_number(n: usize) -> String {
    let s = n.to_string();
    let mut result = String::new();
    let chars: Vec<char> = s.chars().collect();
    let len = chars.len();
    for (i, &ch) in chars.iter().enumerate() {
        result.push(ch);
        let remaining = len - 1 - i;
        if remaining > 0 && remaining % 3 == 0 {
            result.push(',');
        }
    }
    result
}

/// Persistent green local boundary indicator dot
pub fn local_dot(ui: &mut Ui) {
    let (rect, _) = ui.allocate_exact_size(vec2(7.0, 7.0), Sense::hover());
    ui.painter().circle_filled(rect.center(), 3.5, COLOR_GREEN);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_number_commas() {
        assert_eq!(format_number(0), "0");
        assert_eq!(format_number(416), "416");
        assert_eq!(format_number(4160), "4,160");
        assert_eq!(format_number(8192), "8,192");
        assert_eq!(format_number(1234567), "1,234,567");
    }
}
