use egui::{Color32, FontId, Rounding, Stroke, TextStyle, Visuals};

pub const COLOR_INK: Color32 = Color32::from_rgb(0x16, 0x1B, 0x26);
pub const COLOR_INK2: Color32 = Color32::from_rgb(0x44, 0x4D, 0x5C);
pub const COLOR_MUTE: Color32 = Color32::from_rgb(0x77, 0x80, 0x91);
pub const COLOR_LINE: Color32 = Color32::from_rgb(0xD3, 0xD8, 0xDF);
pub const COLOR_BG: Color32 = Color32::from_rgb(0xF7, 0xF8, 0xF9);
pub const COLOR_SIDE: Color32 = Color32::from_rgb(0xE8, 0xEB, 0xEF);
pub const COLOR_PANEL: Color32 = Color32::from_rgb(0xEE, 0xF0, 0xF3);
pub const COLOR_BLUE: Color32 = Color32::from_rgb(0x2A, 0x3F, 0xE0);
pub const COLOR_BLUE2: Color32 = Color32::from_rgb(0x8F, 0x9C, 0xF3);
pub const COLOR_HL: Color32 = Color32::from_rgb(0xF2, 0xD4, 0x52);
pub const COLOR_GREY: Color32 = Color32::from_rgb(0xAA, 0xB2, 0xBF);
pub const COLOR_GREEN: Color32 = Color32::from_rgb(0x1D, 0x7A, 0x4E);
pub const COLOR_WHITE: Color32 = Color32::WHITE;
pub const COLOR_HOVER: Color32 = Color32::from_rgb(0xDD, 0xE1, 0xE7);
pub const COLOR_HOLD: Color32 = Color32::from_rgb(0xC6, 0xCC, 0xD6);

/// Segment colors for the context budget breakdown
pub const COLOR_SEG_CORE: Color32 = COLOR_INK;
pub const COLOR_SEG_TASK: Color32 = COLOR_BLUE;
pub const COLOR_SEG_MEM: Color32 = COLOR_BLUE2;
pub const COLOR_SEG_RECENT: Color32 = COLOR_HL;
pub const COLOR_SEG_TPL: Color32 = COLOR_GREY;
pub const COLOR_SEG_FREE: Color32 = Color32::from_rgb(0xEA, 0xEE, 0xF2);
pub const COLOR_SEG_HOLD: Color32 = COLOR_HOLD;

/// Configure custom editorial light theme visuals for egui
pub fn configure_theme(ctx: &egui::Context) {
    let mut visuals = Visuals::light();

    visuals.override_text_color = Some(COLOR_INK);
    visuals.panel_fill = COLOR_BG;
    visuals.window_fill = COLOR_WHITE;
    visuals.window_stroke = Stroke::new(1.0_f32, COLOR_LINE);

    // Widget styling
    visuals.widgets.noninteractive.bg_fill = COLOR_BG;
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0_f32, COLOR_LINE);
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0_f32, COLOR_INK);

    visuals.widgets.inactive.bg_fill = COLOR_WHITE;
    visuals.widgets.inactive.bg_stroke = Stroke::new(1.0_f32, COLOR_LINE);
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0_f32, COLOR_INK2);
    visuals.widgets.inactive.rounding = Rounding::same(6.0);

    visuals.widgets.hovered.bg_fill = COLOR_HOVER;
    visuals.widgets.hovered.bg_stroke = Stroke::new(1.0_f32, COLOR_INK2);
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0_f32, COLOR_INK);
    visuals.widgets.hovered.rounding = Rounding::same(6.0);

    visuals.widgets.active.bg_fill = COLOR_INK;
    visuals.widgets.active.bg_stroke = Stroke::new(1.0_f32, COLOR_INK);
    visuals.widgets.active.fg_stroke = Stroke::new(1.0_f32, COLOR_WHITE);
    visuals.widgets.active.rounding = Rounding::same(6.0);

    visuals.selection.bg_fill = Color32::from_rgba_premultiplied(42, 63, 224, 40);
    visuals.selection.stroke = Stroke::new(1.0_f32, COLOR_BLUE);

    ctx.set_visuals(visuals);

    // Configure text styles for clear editorial typography hierarchy
    let mut style = (*ctx.style()).clone();
    style.text_styles = [
        (TextStyle::Heading, FontId::new(20.0, egui::FontFamily::Proportional)),
        (TextStyle::Name("Display".into()), FontId::new(26.0, egui::FontFamily::Proportional)),
        (TextStyle::Name("EditorialBody".into()), FontId::new(15.5, egui::FontFamily::Proportional)),
        (TextStyle::Body, FontId::new(14.0, egui::FontFamily::Proportional)),
        (TextStyle::Monospace, FontId::new(13.0, egui::FontFamily::Monospace)),
        (TextStyle::Button, FontId::new(13.0, egui::FontFamily::Proportional)),
        (TextStyle::Small, FontId::new(11.5, egui::FontFamily::Proportional)),
    ]
    .into();

    style.spacing.item_spacing = egui::vec2(8.0, 8.0);
    style.spacing.window_margin = egui::Margin::same(16.0);
    ctx.set_style(style);
}
