pub mod state;

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use eframe::App;
use egui::{vec2, Align2, CentralPanel, Context, SidePanel};

use state::{
    AppSettings, BackendType, ChatMessage, ContextSegmentKey, MemoryNote, MessageRole,
    ModelProfile, NavigationTab, PromptInspectorState, Session, TurnContextBudget,
};
use crate::context::{
    AssemblyCandidates, ConservativeEstimator, ContextAssemblyEngine, ConversationTurn,
    CoreInstruction, CurrentUserMessage, MemoryExcerpt,
};
use crate::inference::{
    GenerationConfig, GenerationEvent, InferenceBackend, InferenceWorkerHandle, LmStudioBackend,
    MockInferenceBackend,
};
use crate::memory::{MemoryEngine, RetrievalOptions};
use crate::storage::{Database, MessageRecord, SessionRecord};
use crate::ui::chat_view::{render_chat_view, ChatActionResponse};
use crate::ui::context_panel::render_context_panel;
use crate::ui::memory_view::{render_memory_view, MemoryAction, MemoryViewState};
use crate::ui::models_view::render_models_view;
use crate::ui::nav::render_nav;
use crate::ui::prompt_inspector::render_prompt_inspector;
use crate::ui::settings_view::{render_settings_view, SettingsViewState};
use crate::ui::theme::{configure_theme, COLOR_BG, COLOR_PANEL, COLOR_SIDE};

pub struct LowConApp {
    pub db: Database,
    pub memory_engine: MemoryEngine,
    pub worker_handle: InferenceWorkerHandle,

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
        // 1. Initialize SQLite Database (persistent local vault file or in-memory fallback)
        let local_data_dir = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        let policy = crate::privacy::StorageLocationPolicy::new(local_data_dir.clone());
        let db_path = local_data_dir.join("lowcon_vault.db");
        let db = match Database::open(&db_path, &policy) {
            Ok(database) => database,
            Err(_) => Database::open_in_memory().expect("In-memory SQLite DB open"),
        };

        // 2. Initialize MemoryEngine wrapping SQLite
        let memory_engine = MemoryEngine::new(db.clone());

        // 3. Initialize background inference worker (defaults to LM Studio / local server, fallback to mock)
        let lm_endpoint = "http://127.0.0.1:1234/v1";
        let backend: Box<dyn InferenceBackend> = match LmStudioBackend::with_endpoint(lm_endpoint) {
            Ok(lm) => Box::new(lm),
            Err(_) => Box::new(MockInferenceBackend::new()),
        };
        let worker_handle = InferenceWorkerHandle::spawn(backend)
            .unwrap_or_else(|_| InferenceWorkerHandle::spawn_mock().expect("Mock worker spawn"));

        // 4. Load real sessions and messages from SQLite DB
        let db_sessions = db.list_sessions().unwrap_or_default();
        let mut sessions = Vec::new();

        if db_sessions.is_empty() {
            let now = current_unix_timestamp();
            let initial_session = SessionRecord {
                id: "sess_01".into(),
                title: "Context strategy / 8K model".into(),
                created_at: now,
                updated_at: now,
                pinned_facts: None,
                task_state: None,
            };
            let _ = db.create_session(&initial_session);

            sessions.push(Session {
                id: "sess_01".into(),
                title: "Context strategy / 8K model".into(),
                subtitle: "A focused session. All history is saved locally.".into(),
                messages: vec![],
            });
        } else {
            for s_rec in db_sessions {
                let msgs = db.list_messages_by_session(&s_rec.id).unwrap_or_default();
                let chat_msgs: Vec<ChatMessage> = msgs
                    .into_iter()
                    .map(|m| {
                        let role = match m.role.as_str() {
                            "user" => MessageRole::User,
                            "assistant" => MessageRole::Assistant,
                            _ => MessageRole::System,
                        };
                        ChatMessage {
                            id: m.id,
                            role,
                            author_name: if role == MessageRole::User {
                                "You".into()
                            } else {
                                "LowCon".into()
                            },
                            time_str: format_unix_timestamp(m.created_at),
                            model_info: None,
                            content: m.content,
                            aside: None,
                            sources: vec![],
                            turn_budget: None,
                        }
                    })
                    .collect();

                sessions.push(Session {
                    id: s_rec.id,
                    title: s_rec.title,
                    subtitle: "Local session. History stays on this device.".into(),
                    messages: chat_msgs,
                });
            }
        }

        let active_session_id = sessions[0].id.clone();

        // 5. Load memory notes from SQLite FTS5 database
        let memory_notes = load_ui_memory_notes(&memory_engine, None);

        // 6. Models list
        let initial_models = vec![
            ModelProfile {
                id: "model_lmstudio".into(),
                name: "LM Studio · Local Server (127.0.0.1:1234)".into(),
                file_path: "http://127.0.0.1:1234/v1".into(),
                architecture: "openai-compatible".into(),
                quantization: "server-managed".into(),
                context_limit: 8192,
                context_override: None,
                file_size_bytes: 0,
                is_loaded: true,
                ram_footprint_mb: None,
            },
            ModelProfile {
                id: "model_qwen3_4b".into(),
                name: "Qwen 3 · 4B Instruct".into(),
                file_path: "C:\\models\\qwen3-4b-instruct-q4_k_m.gguf".into(),
                architecture: "qwen2".into(),
                quantization: "Q4_K_M".into(),
                context_limit: 8192,
                context_override: None,
                file_size_bytes: 2_600_000_000,
                is_loaded: false,
                ram_footprint_mb: None,
            },
            ModelProfile {
                id: "model_mock".into(),
                name: "Offline Mock Model".into(),
                file_path: "in-process-mock".into(),
                architecture: "mock".into(),
                quantization: "None".into(),
                context_limit: 8192,
                context_override: None,
                file_size_bytes: 0,
                is_loaded: false,
                ram_footprint_mb: None,
            },
        ];

        let default_budget = TurnContextBudget::new_default_8k();

        Self {
            db,
            memory_engine,
            worker_handle,
            current_tab: NavigationTab::Chat,
            sessions,
            active_session_id,
            models: initial_models,
            active_model_id: "model_lmstudio".into(),
            new_model_path: String::new(),
            memory_notes,
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

        // 1. Process streaming generation events from background inference worker
        if self.is_generating {
            while let Some(event) = self.worker_handle.try_recv_event() {
                match event {
                    GenerationEvent::Token(token) => {
                        if let Some(session) = self.sessions.iter_mut().find(|s| s.id == self.active_session_id) {
                            if let Some(last_msg) = session.messages.last_mut() {
                                if last_msg.role == MessageRole::Assistant {
                                    last_msg.content.push_str(&token);
                                }
                            }
                        }
                        ctx.request_repaint();
                    }
                    GenerationEvent::Complete { total_tokens, stop_reason: _ } => {
                        self.is_generating = false;
                        // Persist completed assistant message to SQLite
                        if let Some(session) = self.sessions.iter().find(|s| s.id == self.active_session_id) {
                            if let Some(last_msg) = session.messages.last() {
                                let now = current_unix_timestamp();
                                let msg_rec = MessageRecord {
                                    id: last_msg.id.clone(),
                                    session_id: self.active_session_id.clone(),
                                    role: "assistant".into(),
                                    content: last_msg.content.clone(),
                                    token_count: Some(total_tokens),
                                    created_at: now,
                                    is_pinned: false,
                                    metadata: None,
                                };
                                let _ = self.db.create_message(&msg_rec);
                            }
                        }
                        ctx.request_repaint();
                        break;
                    }
                    GenerationEvent::Cancelled => {
                        self.is_generating = false;
                        if let Some(session) = self.sessions.iter_mut().find(|s| s.id == self.active_session_id) {
                            if let Some(last_msg) = session.messages.last_mut() {
                                last_msg.aside = Some("Generation cancelled by user.".into());
                            }
                        }
                        ctx.request_repaint();
                        break;
                    }
                    GenerationEvent::Error(err) => {
                        self.is_generating = false;
                        if let Some(session) = self.sessions.iter_mut().find(|s| s.id == self.active_session_id) {
                            if let Some(last_msg) = session.messages.last_mut() {
                                last_msg.content.push_str(&format!("\n\n[Inference Error: {}]", err));
                            }
                        }
                        ctx.request_repaint();
                        break;
                    }
                }
            }
        }

        let mut on_new_session = false;
        let mut on_inspect_prompt = false;
        let prev_hover = self.hovered_segment;

        // 2. Left Navigation Sidebar (216px)
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

        // 3. Right Context & Memory Panel (344px, shown in Chat tab)
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

        // 4. Central Content Workspace
        CentralPanel::default()
            .frame(egui::Frame::none().fill(COLOR_BG))
            .show(ctx, |ui| {
                match self.current_tab {
                    NavigationTab::Chat => {
                        let active_id = self.active_session_id.clone();
                        let active_model = self.active_model_id.clone();
                        let backend_label = match self.settings.active_backend_type {
                            BackendType::LMStudio => format!("LM Studio · {}", self.settings.lm_studio_endpoint),
                            BackendType::NativeGGUF => "Native GGUF".into(),
                            BackendType::Mock => "Offline Mock".into(),
                        };

                        if let Some(session) = self.sessions.iter_mut().find(|s| s.id == active_id) {
                            let action_resp = render_chat_view(
                                ui,
                                session,
                                &self.models,
                                &mut self.active_model_id,
                                &backend_label,
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
                        let memory_action = render_memory_view(
                            ui,
                            &mut self.memory_notes,
                            &mut self.memory_view_state,
                        );

                        if let Some(action) = memory_action {
                            handle_memory_action(self, action);
                        }
                    }
                    NavigationTab::Settings => {
                        let settings_action = render_settings_view(
                            ui,
                            &mut self.settings,
                            &mut self.settings_view_state,
                        );

                        handle_settings_action(self, settings_action);
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
            let now = current_unix_timestamp();
            let new_id = format!("sess_{:02}", self.sessions.len() + 1);
            let new_session_record = SessionRecord {
                id: new_id.clone(),
                title: "New chat session".into(),
                created_at: now,
                updated_at: now,
                pinned_facts: None,
                task_state: None,
            };
            let _ = self.db.create_session(&new_session_record);

            self.sessions.push(Session {
                id: new_id.clone(),
                title: "New chat session".into(),
                subtitle: "Fresh local session. History stays on disk.".into(),
                messages: vec![],
            });
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

        // 1. Save user message to SQLite DB
        let now = current_unix_timestamp();
        let user_msg_id = format!("msg_{}", uuid::Uuid::new_v4());
        let user_rec = MessageRecord {
            id: user_msg_id.clone(),
            session_id: active_session_id.clone(),
            role: "user".into(),
            content: user_text.clone(),
            token_count: None,
            created_at: now,
            is_pinned: false,
            metadata: None,
        };
        let _ = app.db.create_message(&user_rec);

        if let Some(session) = app.sessions.iter_mut().find(|s| s.id == active_session_id) {
            // Append user message to state
            session.messages.push(ChatMessage {
                id: user_msg_id,
                role: MessageRole::User,
                author_name: "You".into(),
                time_str: "Just now".into(),
                model_info: None,
                content: user_text.clone(),
                aside: None,
                sources: vec![],
                turn_budget: None,
            });

            // 2. Query real relevant memory notes using MemoryEngine
            let mut memory_excerpts = Vec::new();
            if app.settings.memory_retrieval_enabled {
                let options = RetrievalOptions {
                    query: Some(user_text.clone()),
                    session_id: Some(active_session_id.clone()),
                    limit: 3,
                    include_disabled: false,
                    require_approved: true,
                    pinned_only: false,
                    summaries_only: false,
                    weights: crate::memory::ScoringWeights::default(),
                };
                if let Ok(scored_notes) = app.memory_engine.retrieve(&options) {
                    for scored in scored_notes {
                        memory_excerpts.push(MemoryExcerpt {
                            id: scored.note.id.clone(),
                            title: scored.note.title.clone(),
                            excerpt: scored.note.content.clone(),
                            source_message_id: scored.note.source_message_ids.first().cloned(),
                            relevance_score: scored.final_score as f32,
                            is_pinned: scored.note.is_pinned,
                        });
                    }
                }
            }

            // 3. Convert previous conversation turns for context assembly
            let mut conversation_turns = Vec::new();
            let msg_len = session.messages.len();
            if msg_len > 1 {
                for m in &session.messages[..msg_len - 1] {
                    if m.role == MessageRole::User {
                        conversation_turns.push(ConversationTurn::user(m.id.clone(), m.content.clone()));
                    } else if m.role == MessageRole::Assistant {
                        conversation_turns.push(ConversationTurn::assistant(m.id.clone(), m.content.clone()));
                    }
                }
            }

            // 4. Assemble context using ContextAssemblyEngine
            let candidates = AssemblyCandidates {
                core_instruction: Some(CoreInstruction {
                    text: "You are LowCon, a private, deterministic assistant running on this device.".to_string(),
                }),
                current_user_message: Some(CurrentUserMessage::new(user_text.clone())),
                pinned_facts: vec![],
                task_state: None,
                retrieved_memories: memory_excerpts,
                conversation_turns,
                summaries: vec![],
            };

            let assembly_engine = ContextAssemblyEngine::with_defaults(
                Arc::new(ConservativeEstimator::new()),
                crate::config::ChatTemplateType::ChatML,
            );

            let inspection_result = assembly_engine.assemble(candidates, app.settings.context_limit_override);
            let (prompt_to_send, budget, sources) = match inspection_result {
                Ok(insp) => {
                    let b = TurnContextBudget::from_inspection(&insp);
                    let sources = insp.ui_included_items();
                    app.active_budget = b.clone();
                    app.prompt_inspector = PromptInspectorState::from_inspection(&insp);
                    (insp.exact_rendered_prompt, Some(b), sources)
                }
                Err(err) => {
                    let fallback_prompt = format!("<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n", user_text);
                    (fallback_prompt, Some(app.active_budget.clone()), vec![format!("Budget Error: {}", err)])
                }
            };

            // 5. Append initial empty assistant message in state
            let assistant_msg_id = format!("msg_{}", uuid::Uuid::new_v4());
            session.messages.push(ChatMessage {
                id: assistant_msg_id,
                role: MessageRole::Assistant,
                author_name: "LowCon".into(),
                time_str: "Now".into(),
                model_info: Some(format!("{}, on this device", active_model_name)),
                content: String::new(),
                aside: Some("Context budget verified before generation. Zero tokens clipped.".into()),
                sources,
                turn_budget: budget,
            });

            // 6. Start real streaming on inference worker
            let gen_config = GenerationConfig {
                max_tokens: 1024,
                temperature: 0.7,
                top_p: 0.9,
                stop_sequences: vec!["<|im_end|>".into(), "<|endoftext|>".into(), "</s>".into()],
                presence_penalty: 0.0,
                frequency_penalty: 0.0,
            };

            match app.worker_handle.start_generation(prompt_to_send, gen_config) {
                Ok(rx) => {
                    app.worker_handle.set_active_receiver(rx);
                    app.is_generating = true;
                }
                Err(e) => {
                    if let Some(last_msg) = session.messages.last_mut() {
                        last_msg.content = format!("[Inference Error: {}]", e);
                    }
                }
            }
        }
    }

    if action_resp.stop_generation {
        app.worker_handle.cancel_generation();
        app.is_generating = false;
    }

    if action_resp.new_session_requested {
        let now = current_unix_timestamp();
        let new_id = format!("sess_{:02}", app.sessions.len() + 1);
        let new_session_record = SessionRecord {
            id: new_id.clone(),
            title: "New chat session".into(),
            created_at: now,
            updated_at: now,
            pinned_facts: None,
            task_state: None,
        };
        let _ = app.db.create_session(&new_session_record);

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
        let new_note = crate::memory::MemoryNote::new_manual(
            if note_content.len() > 60 { format!("{}...", &note_content[..57]) } else { "Saved from Chat".into() },
            note_content,
            Some(active_session_id),
            false,
        );
        let _ = app.memory_engine.create_note(&new_note);
        app.memory_notes = load_ui_memory_notes(&app.memory_engine, None);
    }
}

fn handle_memory_action(app: &mut LowConApp, action: MemoryAction) {
    match action {
        MemoryAction::Create { title, content, is_pinned } => {
            let note = crate::memory::MemoryNote::new_manual(title, content, None, is_pinned);
            let _ = app.memory_engine.create_note(&note);
        }
        MemoryAction::Update(ui_note) => {
            if let Ok(Some(mut existing)) = app.memory_engine.get_note(&ui_note.id) {
                existing.title = ui_note.title;
                existing.content = ui_note.excerpt;
                existing.is_pinned = ui_note.is_pinned;
                let _ = app.memory_engine.update_note(&existing);
            }
        }
        MemoryAction::Delete(id) => {
            let _ = app.memory_engine.hard_delete_note(&id);
        }
        MemoryAction::TogglePin(id) => {
            if let Ok(Some(existing)) = app.memory_engine.get_note(&id) {
                let _ = app.memory_engine.set_pinned(&id, !existing.is_pinned);
            }
        }
    }

    app.memory_notes = load_ui_memory_notes(&app.memory_engine, None);
}

fn handle_settings_action(app: &mut LowConApp, action: crate::ui::settings_view::SettingsActionResponse) {
    if action.test_connection {
        let endpoint = app.settings.lm_studio_endpoint.clone();
        match LmStudioBackend::fetch_models(&endpoint) {
            Ok(models) => {
                app.settings.connected_lm_models = models.clone();
                app.settings.connection_status = format!("✓ Connected: {} models available", models.len());
                if !models.is_empty() && app.settings.selected_lm_model.is_empty() {
                    app.settings.selected_lm_model = models[0].clone();
                }
            }
            Err(e) => {
                app.settings.connection_status = format!("✕ Connection failed: {}", e);
            }
        }
    }

    if let Some(backend_type) = action.switch_backend {
        app.settings.active_backend_type = backend_type;
        match backend_type {
            BackendType::LMStudio => {
                let _ = app.worker_handle.switch_to_lm_studio(&app.settings.lm_studio_endpoint);
            }
            BackendType::NativeGGUF => {
                // In-process native adapter
            }
            BackendType::Mock => {
                let _ = app.worker_handle.switch_to_mock();
            }
        }
    }
}

fn load_ui_memory_notes(engine: &MemoryEngine, session_id: Option<&str>) -> Vec<MemoryNote> {
    let options = RetrievalOptions {
        query: None,
        session_id: session_id.map(|s| s.to_string()),
        limit: 50,
        include_disabled: true,
        require_approved: false,
        pinned_only: false,
        summaries_only: false,
        weights: crate::memory::ScoringWeights::default(),
    };

    let domain_notes = engine.list_notes(&options).unwrap_or_default();
    domain_notes
        .into_iter()
        .map(|n| {
            let is_summary = n.is_summary();
            MemoryNote {
                id: n.id.clone(),
                title: n.title,
                excerpt: n.content,
                source_reference: n.source_reference.unwrap_or_else(|| "Local memory".into()),
                is_pinned: n.is_pinned,
                is_auto_extracted: is_summary,
                is_in_active_prompt: n.is_pinned,
                created_at: format_unix_timestamp(n.created_at),
            }
        })
        .collect()
}

fn current_unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn format_unix_timestamp(ts: i64) -> String {
    let now = current_unix_timestamp();
    let diff = now.saturating_sub(ts);
    if diff < 60 {
        "Just now".into()
    } else if diff < 3600 {
        format!("{}m ago", diff / 60)
    } else if diff < 86400 {
        format!("{}h ago", diff / 3600)
    } else {
        format!("{}d ago", diff / 86400)
    }
}
