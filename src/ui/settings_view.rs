use egui::{
    Align, Layout, Rounding, Stroke, Ui,
};
use crate::app::state::AppSettings;
use crate::ui::components::{local_dot, toggle_switch};
use crate::ui::theme::*;

pub struct SettingsViewState {
    pub new_passphrase_input: String,
    pub status_message: Option<String>,
}

impl Default for SettingsViewState {
    fn default() -> Self {
        Self {
            new_passphrase_input: String::new(),
            status_message: None,
        }
    }
}

/// Render the Application Settings & Privacy Policy View
pub fn render_settings_view(
    ui: &mut Ui,
    settings: &mut AppSettings,
    view_state: &mut SettingsViewState,
) {
    ui.vertical(|ui| {
        // Top Header Bar
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
                        egui::RichText::new("Settings")
                            .strong()
                            .size(13.0)
                            .color(COLOR_INK),
                    );

                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.horizontal(|ui| {
                            local_dot(ui);
                            ui.label(
                                egui::RichText::new("Local Boundary Enforced")
                                    .size(12.5)
                                    .color(COLOR_INK2),
                            );
                        });
                    });
                });
            });

        // Settings Content Scroll Area
        egui::ScrollArea::vertical()
            .id_salt("settings_view_scroll")
            .show(ui, |ui| {
                ui.add_space(24.0);

                let max_width = 720.0;
                ui.vertical_centered(|ui| {
                    ui.set_width(ui.available_width().min(max_width));

                    // Title
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.label(
                                egui::RichText::new("Preferences & Security")
                                    .strong()
                                    .size(24.0)
                                    .color(COLOR_INK),
                            );
                            ui.add_space(2.0);
                            ui.label(
                                egui::RichText::new("Configure deterministic token budgets, encrypted storage, and review privacy boundaries.")
                                    .size(13.0)
                                    .color(COLOR_MUTE),
                            );
                        });
                    });

                    ui.add_space(20.0);

                    // Section 1: Context Budget Allocation & Overrides
                    render_section_card(ui, "CONTEXT BUDGET ALLOCATION", |ui| {
                        ui.label(
                            egui::RichText::new("LowCon guarantees that prompt + output reserve + safety margin <= model context limit. Configure the default reserve ratios below:")
                                .size(12.5)
                                .color(COLOR_INK2),
                        );

                        ui.add_space(12.0);

                        // Output Reserve Slider
                        ui.horizontal(|ui| {
                            ui.label(
                                egui::RichText::new("Output Reserve:")
                                    .strong()
                                    .size(13.0)
                                    .color(COLOR_INK),
                            );
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                let label = format!("{:.0}% of context", settings.output_reserve_pct);
                                ui.label(egui::RichText::new(label).color(COLOR_MUTE).size(12.5));
                            });
                        });
                        ui.add(
                            egui::Slider::new(&mut settings.output_reserve_pct, 5.0..=40.0)
                                .suffix("%")
                                .step_by(1.0),
                        );

                        ui.add_space(12.0);

                        // Safety Margin Slider
                        ui.horizontal(|ui| {
                            ui.label(
                                egui::RichText::new("Context Safety Margin:")
                                    .strong()
                                    .size(13.0)
                                    .color(COLOR_INK),
                            );
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                let label = format!("{:.0}% buffer", settings.safety_margin_pct);
                                ui.label(egui::RichText::new(label).color(COLOR_MUTE).size(12.5));
                            });
                        });
                        ui.add(
                            egui::Slider::new(&mut settings.safety_margin_pct, 1.0..=15.0)
                                .suffix("%")
                                .step_by(0.5),
                        );

                        ui.add_space(12.0);

                        // Default Context Limit Override
                        ui.horizontal(|ui| {
                            ui.label(
                                egui::RichText::new("Default Working Context Limit:")
                                    .strong()
                                    .size(13.0)
                                    .color(COLOR_INK),
                            );
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                egui::ComboBox::from_id_salt("context_preset_combo")
                                    .selected_text(format!("{} tokens", settings.context_limit_override))
                                    .show_ui(ui, |ui| {
                                        ui.selectable_value(&mut settings.context_limit_override, 2048, "2,048 tokens (2K)");
                                        ui.selectable_value(&mut settings.context_limit_override, 4096, "4,096 tokens (4K)");
                                        ui.selectable_value(&mut settings.context_limit_override, 8192, "8,192 tokens (8K - Recommended)");
                                        ui.selectable_value(&mut settings.context_limit_override, 16384, "16,384 tokens (16K)");
                                        ui.selectable_value(&mut settings.context_limit_override, 32768, "32,768 tokens (32K)");
                                    });
                            });
                        });
                    });

                    ui.add_space(16.0);

                    // Section 2: Encrypted Local Storage Vault
                    render_section_card(ui, "ENCRYPTED LOCAL STORAGE VAULT", |ui| {
                        ui.label(
                            egui::RichText::new("All conversation history, memory notes, and model configs are stored in a local SQLite database encrypted with ChaCha20-Poly1305 and Argon2id key derivation.")
                                .size(12.5)
                                .color(COLOR_INK2),
                        );

                        ui.add_space(10.0);

                        // Storage path
                        ui.label(
                            egui::RichText::new("Storage Location:")
                                .strong()
                                .size(12.5)
                                .color(COLOR_INK),
                        );
                        ui.label(
                            egui::RichText::new(&settings.storage_path)
                                .size(12.0)
                                .color(COLOR_MUTE),
                        );

                        ui.add_space(10.0);

                        // Vault Lock / Unlock Status
                        ui.horizontal(|ui| {
                            ui.label(
                                egui::RichText::new("Vault Status:")
                                    .strong()
                                    .size(12.5)
                                    .color(COLOR_INK),
                            );
                            if settings.is_vault_locked {
                                ui.label(
                                    egui::RichText::new("🔒 Locked")
                                        .strong()
                                        .size(12.5)
                                        .color(egui::Color32::from_rgb(0xD9, 0x38, 0x3A)),
                                );
                            } else {
                                ui.label(
                                    egui::RichText::new("🔓 Unlocked (Active Session)")
                                        .strong()
                                        .size(12.5)
                                        .color(COLOR_GREEN),
                                );
                            }

                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                if settings.is_vault_locked {
                                    if ui.button("Unlock Vault").clicked() {
                                        settings.is_vault_locked = false;
                                        settings.vault_passphrase = view_state.new_passphrase_input.clone();
                                        view_state.new_passphrase_input.clear();
                                        view_state.status_message = Some("Vault unlocked successfully.".into());
                                    }
                                } else {
                                    if ui.button("Lock Vault Now").clicked() {
                                        settings.is_vault_locked = true;
                                        settings.vault_passphrase.clear();
                                        view_state.status_message = Some("Vault locked. Memory and chat encrypted.".into());
                                    }
                                }
                            });
                        });

                        if settings.is_vault_locked {
                            ui.add_space(8.0);
                            ui.horizontal(|ui| {
                                ui.label(egui::RichText::new("Passphrase:").size(12.0).color(COLOR_INK2));
                                let pass_edit = egui::TextEdit::singleline(&mut view_state.new_passphrase_input)
                                    .password(true)
                                    .hint_text("Enter vault passphrase");
                                ui.add(pass_edit);
                            });
                        }

                        if let Some(msg) = &view_state.status_message {
                            ui.add_space(6.0);
                            ui.label(
                                egui::RichText::new(msg)
                                    .size(12.0)
                                    .color(COLOR_BLUE),
                            );
                        }
                    });

                    ui.add_space(16.0);

                    // Section 3: Diagnostic Logging Policy
                    render_section_card(ui, "DIAGNOSTIC LOGGING POLICY", |ui| {
                        ui.horizontal(|ui| {
                            ui.vertical(|ui| {
                                ui.label(
                                    egui::RichText::new("Local Diagnostic Logs")
                                        .strong()
                                        .size(13.0)
                                        .color(COLOR_INK),
                                );
                                ui.label(
                                    egui::RichText::new("Diagnostic logs are strictly local, redacted by default, and never contain prompt or conversation text.")
                                        .size(12.0)
                                        .color(COLOR_MUTE),
                                );
                            });

                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                toggle_switch(ui, &mut settings.diagnostic_logs_enabled);
                            });
                        });
                    });

                    ui.add_space(16.0);

                    // Section 4: Privacy Boundary Explanation
                    render_section_card(ui, "PRIVACY BOUNDARY & AUDIT", |ui| {
                        ui.label(
                            egui::RichText::new("LowCon Architectural Commitments:")
                                .strong()
                                .size(13.0)
                                .color(COLOR_INK),
                        );
                        ui.add_space(4.0);

                        let commitments = [
                            "Zero runtime network calls: No HTTP, HTTPS, sockets, WebSockets, or IPC listeners.",
                            "Zero cloud inference: Models run 100% in-process via local GGUF weights on your CPU/GPU.",
                            "Zero telemetry: No analytics, crash reporting, update checkers, or user fingerprinting.",
                            "Zero automatic whole-disk scanning: LowCon only touches files you explicitly select.",
                            "Vetted local cryptography: ChaCha20-Poly1305 with Argon2id password-based key derivation.",
                        ];

                        for item in commitments {
                            ui.horizontal(|ui| {
                                ui.label(egui::RichText::new("•").strong().color(COLOR_BLUE));
                                ui.label(egui::RichText::new(item).size(12.5).color(COLOR_INK2));
                            });
                            ui.add_space(2.0);
                        }
                    });

                    ui.add_space(24.0);
                });
            });
    });
}

fn render_section_card<R>(
    ui: &mut Ui,
    header: &str,
    add_contents: impl FnOnce(&mut Ui) -> R,
) -> R {
    egui::Frame::none()
        .fill(COLOR_WHITE)
        .stroke(Stroke::new(1.0_f32, COLOR_LINE))
        .rounding(Rounding::same(8.0))
        .inner_margin(egui::Margin::same(16.0))
        .show(ui, |ui| {
            ui.label(
                egui::RichText::new(header)
                    .strong()
                    .size(11.5)
                    .color(COLOR_MUTE),
            );
            ui.add_space(10.0);
            add_contents(ui)
        })
        .inner
}
