pub mod state;

use eframe::App;
use egui::{vec2, Align2, CentralPanel, Context, SidePanel};
use state::{
    AppSettings, ChatMessage, ContextSegmentKey, MemoryNote, MessageRole, ModelProfile,
    NavigationTab, PromptInspectorState, Session, TurnContextBudget,
};
use crate::ui::chat_view::{render_chat_view, ChatActionResponse};
use crate::ui::context_panel::render_context_panel;
use crate::ui::memory_view::{render_memory_view, MemoryViewState};
use crate::ui::models_view::render_models_view;
use crate::ui::nav::render_nav;
use crate::ui::prompt_inspector::render_prompt_inspector;
use crate::ui::settings_view::{render_settings_view, SettingsViewState};
use crate::ui::theme::{configure_theme, COLOR_BG, COLOR_PANEL, COLOR_SIDE};

pub struct LowConApp {
    pub current_tab: NavigationTab,
    pub sessions: Vec<Session>,
    pub active_session_id: String,
    pub models: Vec<ModelProfile>,
    pub active_model_id: String,
    pub new_model_path: String,
    pub memory_notes: Vec<MemoryNote>,
    pub settings: AppSettings,
    pub composer_text: String,
    pub is_generating: bool,
    pub active_budget: TurnContextBudget,
    pub hovered_segment: Option<ContextSegmentKey>,
    pub prompt_inspector: PromptInspectorState,
    pub memory_view_state: MemoryViewState,
    pub settings_view_state: SettingsViewState,
    pub sources_modal: Option<Vec<String>>,
}

impl Default for LowConApp {
    fn default() -> Self {
        let default_budget = TurnContextBudget::new_default_8k();

        let ref_session = Session {
            id: "sess_01".into(),
            title: "Context strategy / 8K model".into(),
            subtitle: "A focused session. All history is saved locally.".into(),
            messages: vec![
                ChatMessage {
                    id: "msg_01".into(),
                    role: MessageRole::User,
                    author_name: "You".into(),
                    time_str: "4:18 PM".into(),
                    model_info: None,
                    content: "Why does my smaller model keep losing earlier constraints when a conversation gets long? I don't want to increase the context window just to brute-force it.".into(),
                    aside: None,
                    sources: vec![],
                    turn_budget: None,
                },
                ChatMessage {
                    id: "msg_02".into(),
                    role: MessageRole::Assistant,
                    author_name: "LowCon".into(),
                    time_str: "4:18 PM".into(),
                    model_info: Some("Qwen 3 4B, on this device".into()),
                    content: "The model isn't really remembering the whole conversation. It only sees the tokens included in its current prompt. As the chat grows, older details either get pushed out or compete with the current request.\n\nThe better fix is to separate history from active context. Keep the full transcript on disk, then build a small, relevant prompt for every turn.\n\nFor this request, the harness selected your active constraint, two source-linked memory notes, and the newest turns. Older messages remain saved locally but aren't spending tokens right now.".into(),
                    aside: Some("Context selection happens in the harness, before inference. The model doesn't decide what gets remembered or silently rewrite the transcript.".into()),
                    sources: vec![
                        "Session 04, message 18 (Keep original conversation history intact)".into(),
                        "Note 07, approved by you (Prefer deterministic prompt packing over model-managed recall)".into(),
                    ],
                    turn_budget: Some(default_budget.clone()),
                },
            ],
        };

        let initial_sessions = vec![
            ref_session,
            Session {
                id: "sess_02".into(),
                title: "Rust application architecture".into(),
                subtitle: "Safe FFI wrappers and zero-copy token buffers".into(),
                messages: vec![],
            },
            Session {
                id: "sess_03".into(),
                title: "Benchmark notes, Q4".into(),
                subtitle: "Prompt assembly latency vs SQLite retrieval overhead".into(),
                messages: vec![],
            },
            Session {
                id: "sess_04".into(),
                title: "Prompt packing experiments".into(),
                subtitle: "4K limit test with priority-based turn trimming".into(),
                messages: vec![],
            },
        ];

        let initial_models = vec![
            ModelProfile {
                id: "model_qwen3_4b".into(),
                name: "Qwen 3 · 4B Instruct".into(),
                file_path: "C:\\models\\qwen3-4b-instruct-q4_k_m.gguf".into(),
                architecture: "qwen2".into(),
                quantization: "Q4_K_M".into(),
                context_limit: 8192,
                context_override: None,
                file_size_bytes: 2_600_000_000,
                is_loaded: true,
                ram_footprint_mb: Some(2420),
            },
            ModelProfile {
                id: "model_llama32_3b".into(),
                name: "Llama 3.2 · 3B Instruct".into(),
                file_path: "C:\\models\\llama-3.2-3b-instruct.gguf".into(),
                architecture: "llama".into(),
                quantization: "Q4_K_M".into(),
                context_limit: 8192,
                context_override: Some(4096),
                file_size_bytes: 2_200_000_000,
                is_loaded: false,
                ram_footprint_mb: None,
            },
            ModelProfile {
                id: "model_smollm_1b".into(),
                name: "SmolLM2 · 1.7B".into(),
                file_path: "C:\\models\\smollm2-1.7b-instruct.gguf".into(),
                architecture: "llama".into(),
                quantization: "Q4_K_M".into(),
                context_limit: 2048,
                context_override: None,
                file_size_bytes: 1_100_000_000,
                is_loaded: false,
                ram_footprint_mb: None,
            },
        ];

        let initial_notes = vec![
            MemoryNote {
                id: "note_01".into(),
                title: "Original History Preservation".into(),
                excerpt: "Keep original conversation history intact".into(),
                source_reference: "Session 04, message 18".into(),
                is_pinned: true,
                is_auto_extracted: false,
                is_in_active_prompt: true,
                created_at: "2 hours ago".into(),
            },
            MemoryNote {
                id: "note_02".into(),
                title: "Deterministic Packing Over Recall".into(),
                excerpt: "Prefer deterministic prompt packing over model-managed recall".into(),
                source_reference: "Note 07, approved by you".into(),
                is_pinned: false,
                is_auto_extracted: false,
                is_in_active_prompt: true,
                created_at: "1 day ago".into(),
            },
            MemoryNote {
                id: "note_03".into(),
                title: "Zero Network Boundary".into(),
                excerpt: "Never allow external network or localhost HTTP communication".into(),
                source_reference: "System policy".into(),
                is_pinned: true,
                is_auto_extracted: false,
                is_in_active_prompt: false,
                created_at: "3 days ago".into(),
            },
            MemoryNote {
                id: "note_04".into(),
                title: "Output Reserve Ratio".into(),
                excerpt: "Maintain minimum 20% output reserve for structured code blocks".into(),
                source_reference: "Session 02, message 09".into(),
                is_pinned: false,
                is_auto_extracted: true,
                is_in_active_prompt: false,
                created_at: "4 days ago".into(),
            },
        ];

        Self {
            current_tab: NavigationTab::Chat,
            sessions: initial_sessions,
            active_session_id: "sess_01".into(),
            models: initial_models,
            active_model_id: "model_qwen3_4b".into(),
            new_model_path: String::new(),
            memory_notes: initial_notes,
            settings: AppSettings::default(),
            composer_text: String::new(),
            is_generating: false,
            active_budget: default_budget,
            hovered_segment: None,
            prompt_inspector: PromptInspectorState::default(),
            memory_view_state: MemoryViewState::default(),
            settings_view_state: SettingsViewState::default(),
            sources_modal: None,
        }
    }
}

impl App for LowConApp {
    fn update(&mut self, ctx: &Context, _frame: &mut eframe::Frame) {
        configure_theme(ctx);

        let mut on_new_session = false;
        let mut on_inspect_prompt = false;

        // Reset hovered segment if cursor is elsewhere
        let prev_hover = self.hovered_segment;

        // 1. Left Navigation Sidebar
        SidePanel::left("left_nav_bar")
            .exact_width(216.0)
            .resizable(false)
            .frame(egui::Frame::none().fill(COLOR_SIDE))
            .show(ctx, |ui| {
                render_nav(
                    ui,
                    &mut self.current_tab,
                    &self.sessions,
                    &mut self.active_session_id,
                    &mut on_new_session,
                );
            });

        // 2. Right Context & Memory Panel (shown in Chat view)
        if self.current_tab == NavigationTab::Chat {
            SidePanel::right("right_context_panel")
                .exact_width(344.0)
                .resizable(false)
                .frame(egui::Frame::none().fill(COLOR_PANEL))
                .show(ctx, |ui| {
                    render_context_panel(
                        ui,
                        &self.active_budget,
                        &self.memory_notes,
                        &mut self.settings.memory_retrieval_enabled,
                        &mut self.hovered_segment,
                        &mut on_inspect_prompt,
                    );
                });
        }

        // 3. Central Content Workspace
        CentralPanel::default()
            .frame(egui::Frame::none().fill(COLOR_BG))
            .show(ctx, |ui| {
                match self.current_tab {
                    NavigationTab::Chat => {
                        let active_id = self.active_session_id.clone();
                        let active_model = self.active_model_id.clone();

                        if let Some(session) = self.sessions.iter_mut().find(|s| s.id == active_id) {
                            let action_resp = render_chat_view(
                                ui,
                                session,
                                &self.models,
                                &mut self.active_model_id,
                                &mut self.composer_text,
                                &mut self.settings.memory_retrieval_enabled,
                                self.is_generating,
                                &mut self.hovered_segment,
                            );

                            handle_chat_actions(
                                self,
                                action_resp,
                                active_id,
                                active_model,
                            );
                        }
                    }
                    NavigationTab::Models => {
                        render_models_view(
                            ui,
                            &mut self.models,
                            &mut self.active_model_id,
                            &mut self.new_model_path,
                        );
                    }
                    NavigationTab::Memory => {
                        render_memory_view(
                            ui,
                            &mut self.memory_notes,
                            &mut self.memory_view_state,
                        );
                    }
                    NavigationTab::Settings => {
                        render_settings_view(
                            ui,
                            &mut self.settings,
                            &mut self.settings_view_state,
                        );
                    }
                }
            });

        // Open prompt inspector modal if requested
        if on_inspect_prompt {
            self.prompt_inspector.is_open = true;
        }

        // Render Prompt Inspector Modal Window
        render_prompt_inspector(ctx, &mut self.prompt_inspector);

        // Sources Modal Window
        if let Some(sources) = &self.sources_modal {
            let mut is_open = true;
            let mut close_clicked = false;
            egui::Window::new("Retrieved Sources & References")
                .open(&mut is_open)
                .resizable(false)
                .default_size(vec2(480.0, 260.0))
                .anchor(Align2::CENTER_CENTER, vec2(0.0, 0.0))
                .show(ctx, |ui| {
                    ui.label("The following sources were prioritized and packed into the prompt for this turn:");
                    ui.add_space(8.0);
                    for (i, src) in sources.iter().enumerate() {
                        ui.horizontal(|ui| {
                            ui.label(egui::RichText::new(format!("{}.", i + 1)).strong());
                            ui.label(src);
                        });
                        ui.add_space(4.0);
                    }
                    ui.add_space(12.0);
                    if ui.button("Close").clicked() {
                        close_clicked = true;
                    }
                });
            if !is_open || close_clicked {
                self.sources_modal = None;
            }
        }

        // Handle New Session creation
        if on_new_session {
            let new_id = format!("sess_{:02}", self.sessions.len() + 1);
            let new_session = Session {
                id: new_id.clone(),
                title: "New chat session".into(),
                subtitle: "Fresh local session. History stays on disk.".into(),
                messages: vec![],
            };
            self.sessions.push(new_session);
            self.active_session_id = new_id;
            self.current_tab = NavigationTab::Chat;
        }

        // Request repaint if hovering changes
        if prev_hover != self.hovered_segment {
            ctx.request_repaint();
        }
    }
}

fn handle_chat_actions(
    app: &mut LowConApp,
    action_resp: ChatActionResponse,
    active_session_id: String,
    active_model_id: String,
) {
    if let Some(user_text) = action_resp.send_message {
        let active_model_name = app
            .models
            .iter()
            .find(|m| m.id == active_model_id)
            .map(|m| m.name.clone())
            .unwrap_or_else(|| "Local Model".into());

        if let Some(session) = app.sessions.iter_mut().find(|s| s.id == active_session_id) {
            // Add user message
            session.messages.push(ChatMessage {
                id: format!("msg_{}", session.messages.len() + 1),
                role: MessageRole::User,
                author_name: "You".into(),
                time_str: "Just now".into(),
                model_info: None,
                content: user_text.clone(),
                aside: None,
                sources: vec![],
                turn_budget: None,
            });

            // Add simulated assistant reply
            session.messages.push(ChatMessage {
                id: format!("msg_{}", session.messages.len() + 1),
                role: MessageRole::Assistant,
                author_name: "LowCon".into(),
                time_str: "Just now".into(),
                model_info: Some(format!("{}, on this device", active_model_name)),
                content: format!(
                    "Understood. Your request ('{}') has been processed within the local context budget.\n\nAll constraints and active task rules remain preserved.",
                    user_text
                ),
                aside: Some("Context budget verified before generation. Zero tokens clipped.".into()),
                sources: vec!["Active task state".into()],
                turn_budget: Some(app.active_budget.clone()),
            });
        }
    }

    if action_resp.stop_generation {
        app.is_generating = false;
    }

    if action_resp.new_session_requested {
        let new_id = format!("sess_{:02}", app.sessions.len() + 1);
        app.sessions.push(Session {
            id: new_id.clone(),
            title: "New chat session".into(),
            subtitle: "Fresh local session. History stays on disk.".into(),
            messages: vec![],
        });
        app.active_session_id = new_id;
    }

    if let Some(sources) = action_resp.open_sources_modal {
        app.sources_modal = Some(sources);
    }

    if let Some(note_content) = action_resp.save_as_note {
        app.memory_notes.push(MemoryNote {
            id: format!("note_{}", app.memory_notes.len() + 1),
            title: "Saved from Chat".into(),
            excerpt: if note_content.len() > 80 {
                format!("{}...", &note_content[..77])
            } else {
                note_content
            },
            source_reference: format!("Session {}", active_session_id),
            is_pinned: false,
            is_auto_extracted: false,
            is_in_active_prompt: false,
            created_at: "Just now".into(),
        });
    }
}
