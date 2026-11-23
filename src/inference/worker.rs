use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::{Builder, JoinHandle};
use std::time::Duration;

use crate::config::ModelProfile;
use super::backend::InferenceBackend;
use super::error::InferenceError;
use super::mock::MockInferenceBackend;
use super::types::{GenerationConfig, GenerationEvent, ModelMetadata, WorkerStatus};

/// Internal commands passed to the background inference worker.
pub enum WorkerCommand {
    LoadModel {
        profile: ModelProfile,
        respond_to: Sender<Result<ModelMetadata, InferenceError>>,
    },
    UnloadModel {
        respond_to: Sender<Result<(), InferenceError>>,
    },
    CountTokens {
        text: String,
        respond_to: Sender<Result<usize, InferenceError>>,
    },
    StartGeneration {
        prompt: String,
        config: GenerationConfig,
        token_tx: Sender<GenerationEvent>,
        cancel_token: Arc<AtomicBool>,
    },
    SwitchBackend {
        backend: Box<dyn InferenceBackend>,
        respond_to: Sender<Result<(), InferenceError>>,
    },
    Shutdown,
}

/// Handle held by the UI thread to interact with the background inference worker without blocking.
pub struct InferenceWorkerHandle {
    cmd_tx: Sender<WorkerCommand>,
    thread_handle: Option<JoinHandle<()>>,
    active_cancel_token: Arc<Mutex<Option<Arc<AtomicBool>>>>,
    active_token_rx: Arc<Mutex<Option<Receiver<GenerationEvent>>>>,
    status: Arc<RwLock<WorkerStatus>>,
}

impl InferenceWorkerHandle {
    /// Spawns a new background inference worker thread wrapping the given backend.
    pub fn spawn(mut backend: Box<dyn InferenceBackend>) -> Result<Self, InferenceError> {
        let (cmd_tx, cmd_rx) = channel::<WorkerCommand>();
        let status = Arc::new(RwLock::new(WorkerStatus::Unloaded));
        let status_worker = status.clone();

        let thread_handle = Builder::new()
            .name("lowcon-inference-worker".to_string())
            .spawn(move || {
                while let Ok(cmd) = cmd_rx.recv() {
                    match cmd {
                        WorkerCommand::LoadModel { profile, respond_to } => {
                            {
                                let mut st = status_worker.write().unwrap();
                                *st = WorkerStatus::Loading {
                                    model_name: profile.name.clone(),
                                };
                            }

                            let result = backend.load_model(&profile);

                            {
                                let mut st = status_worker.write().unwrap();
                                match &result {
                                    Ok(meta) => *st = WorkerStatus::Loaded(meta.clone()),
                                    Err(err) => *st = WorkerStatus::Error(err.to_string()),
                                }
                            }

                            let _ = respond_to.send(result);
                        }

                        WorkerCommand::UnloadModel { respond_to } => {
                            let result = backend.unload_model();
                            {
                                let mut st = status_worker.write().unwrap();
                                *st = WorkerStatus::Unloaded;
                            }
                            let _ = respond_to.send(result);
                        }

                        WorkerCommand::CountTokens { text, respond_to } => {
                            let result = backend.token_count(&text);
                            let _ = respond_to.send(result);
                        }

                        WorkerCommand::StartGeneration {
                            prompt,
                            config,
                            token_tx,
                            cancel_token,
                        } => {
                            let model_name = backend
                                .get_metadata()
                                .map(|m| m.name.clone())
                                .unwrap_or_else(|| "active_model".to_string());

                            {
                                let mut st = status_worker.write().unwrap();
                                *st = WorkerStatus::Generating { model_name };
                            }

                            let gen_result = backend.stream_generate(
                                &prompt,
                                &config,
                                token_tx.clone(),
                                cancel_token,
                            );

                            if let Err(err) = gen_result {
                                if err != InferenceError::Cancelled {
                                    let _ = token_tx.send(GenerationEvent::Error(err.to_string()));
                                }
                            }

                            {
                                let mut st = status_worker.write().unwrap();
                                if let Some(meta) = backend.get_metadata() {
                                    *st = WorkerStatus::Loaded(meta.clone());
                                } else {
                                    *st = WorkerStatus::Unloaded;
                                }
                            }
                        }

                        WorkerCommand::SwitchBackend {
                            backend: new_backend,
                            respond_to,
                        } => {
                            let _ = backend.unload_model();
                            backend = new_backend;
                            {
                                let mut st = status_worker.write().unwrap();
                                *st = WorkerStatus::Unloaded;
                            }
                            let _ = respond_to.send(Ok(()));
                        }

                        WorkerCommand::Shutdown => {
                            let _ = backend.unload_model();
                            let mut st = status_worker.write().unwrap();
                            *st = WorkerStatus::Unloaded;
                            break;
                        }
                    }
                }
            })
            .map_err(|e| InferenceError::BackendError(format!("Failed to spawn worker thread: {}", e)))?;

        Ok(Self {
            cmd_tx,
            thread_handle: Some(thread_handle),
            active_cancel_token: Arc::new(Mutex::new(None)),
            active_token_rx: Arc::new(Mutex::new(None)),
            status,
        })
    }

    /// Spawns a default worker using the deterministic mock backend.
    pub fn spawn_mock() -> Result<Self, InferenceError> {
        Self::spawn(Box::new(MockInferenceBackend::new()))
    }

    /// Asynchronously initiate model loading. Returns a receiver for the result.
    pub fn load_model(&self, profile: ModelProfile) -> Receiver<Result<ModelMetadata, InferenceError>> {
        let (tx, rx) = channel();
        let _ = self.cmd_tx.send(WorkerCommand::LoadModel {
            profile,
            respond_to: tx,
        });
        rx
    }

    /// Synchronously load a model with a timeout (ideal for tests).
    pub fn load_model_sync(
        &self,
        profile: ModelProfile,
        timeout: Duration,
    ) -> Result<ModelMetadata, InferenceError> {
        let rx = self.load_model(profile);
        rx.recv_timeout(timeout)
            .map_err(|_| InferenceError::BackendError("Load model timed out".to_string()))?
    }

    /// Asynchronously initiate model unloading. Returns a receiver for the result.
    pub fn unload_model(&self) -> Receiver<Result<(), InferenceError>> {
        let (tx, rx) = channel();
        let _ = self.cmd_tx.send(WorkerCommand::UnloadModel { respond_to: tx });
        rx
    }

    /// Synchronously unload a model with a timeout.
    pub fn unload_model_sync(&self, timeout: Duration) -> Result<(), InferenceError> {
        let rx = self.unload_model();
        rx.recv_timeout(timeout)
            .map_err(|_| InferenceError::BackendError("Unload model timed out".to_string()))?
    }

    /// Request token count asynchronously.
    pub fn token_count(&self, text: String) -> Receiver<Result<usize, InferenceError>> {
        let (tx, rx) = channel();
        let _ = self.cmd_tx.send(WorkerCommand::CountTokens {
            text,
            respond_to: tx,
        });
        rx
    }

    /// Start streaming generation without blocking the caller thread.
    /// Returns a receiver yielding `GenerationEvent`s.
    pub fn start_generation(
        &self,
        prompt: String,
        config: GenerationConfig,
    ) -> Result<Receiver<GenerationEvent>, InferenceError> {
        if !self.is_loaded() {
            return Err(InferenceError::ModelNotLoaded);
        }

        let (token_tx, token_rx) = channel();
        let cancel_token = Arc::new(AtomicBool::new(false));

        // Store active cancellation token and receiver
        {
            let mut cancel_guard = self.active_cancel_token.lock().unwrap();
            *cancel_guard = Some(cancel_token.clone());
        }

        self.cmd_tx
            .send(WorkerCommand::StartGeneration {
                prompt,
                config,
                token_tx,
                cancel_token,
            })
            .map_err(|_| InferenceError::WorkerChannelClosed)?;

        Ok(token_rx)
    }

    /// Immediately cancel any active generation.
    pub fn cancel_generation(&self) {
        let mut cancel_guard = self.active_cancel_token.lock().unwrap();
        if let Some(token) = cancel_guard.take() {
            token.store(true, Ordering::SeqCst);
        }
    }

    /// Poll for the next generation event on the active receiver without blocking.
    pub fn try_recv_event(&self) -> Option<GenerationEvent> {
        let mut rx_guard = self.active_token_rx.lock().unwrap();
        if let Some(rx) = rx_guard.as_ref() {
            match rx.try_recv() {
                Ok(event) => {
                    if matches!(event, GenerationEvent::Complete { .. } | GenerationEvent::Cancelled | GenerationEvent::Error(_)) {
                        // Clear active channel on termination
                        *rx_guard = None;
                    }
                    Some(event)
                }
                Err(_) => None,
            }
        } else {
            None
        }
    }

    /// Set an active token receiver for UI polling.
    pub fn set_active_receiver(&self, rx: Receiver<GenerationEvent>) {
        let mut rx_guard = self.active_token_rx.lock().unwrap();
        *rx_guard = Some(rx);
    }

    /// Get the current worker status.
    pub fn status(&self) -> WorkerStatus {
        self.status.read().unwrap().clone()
    }

    /// Check if a model is currently loaded.
    pub fn is_loaded(&self) -> bool {
        self.status().is_loaded()
    }

    /// Check if inference generation is currently running.
    pub fn is_generating(&self) -> bool {
        self.status().is_generating()
    }

    /// Switch the active backend dynamically (e.g. to LM Studio or native GGUF).
    pub fn switch_backend(&self, backend: Box<dyn InferenceBackend>) -> Result<(), InferenceError> {
        self.cancel_generation();
        let (tx, rx) = channel();
        self.cmd_tx
            .send(WorkerCommand::SwitchBackend {
                backend,
                respond_to: tx,
            })
            .map_err(|_| InferenceError::WorkerChannelClosed)?;
        rx.recv()
            .map_err(|_| InferenceError::WorkerChannelClosed)?
    }

    /// Switch to LM Studio / local server backend with the given endpoint.
    pub fn switch_to_lm_studio(&self, endpoint: impl Into<String>) -> Result<(), InferenceError> {
        let lm_backend = crate::inference::lm_studio::LmStudioBackend::with_endpoint(endpoint)?;
        self.switch_backend(Box::new(lm_backend))
    }

    /// Switch to the deterministic mock backend.
    pub fn switch_to_mock(&self) -> Result<(), InferenceError> {
        self.switch_backend(Box::new(MockInferenceBackend::new()))
    }

    /// Cleanly shutdown the worker thread.
    pub fn shutdown(&mut self) {
        self.cancel_generation();
        let _ = self.cmd_tx.send(WorkerCommand::Shutdown);
        if let Some(handle) = self.thread_handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for InferenceWorkerHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_worker_thread_lifecycle() {
        let mut worker = InferenceWorkerHandle::spawn_mock().unwrap();
        assert!(!worker.is_loaded());
        assert_eq!(worker.status(), WorkerStatus::Unloaded);

        // Load model
        let profile = ModelProfile::new("Worker Model", PathBuf::from("mock.gguf"), 4096);
        let meta = worker.load_model_sync(profile, Duration::from_secs(2)).unwrap();
        assert_eq!(meta.name, "Worker Model");
        assert!(worker.is_loaded());

        // Token count
        let rx = worker.token_count("Hello LowCon worker".to_string());
        let count = rx.recv_timeout(Duration::from_secs(1)).unwrap().unwrap();
        assert!(count > 0);

        // Generate stream
        let event_rx = worker
            .start_generation("Tell me about offline local models".to_string(), GenerationConfig::default())
            .unwrap();

        let mut received_tokens = Vec::new();
        let mut completed = false;

        while let Ok(event) = event_rx.recv_timeout(Duration::from_secs(2)) {
            match event {
                GenerationEvent::Token(t) => received_tokens.push(t),
                GenerationEvent::Complete { .. } => {
                    completed = true;
                    break;
                }
                _ => (),
            }
        }

        assert!(completed);
        assert!(!received_tokens.is_empty());

        // Unload model
        worker.unload_model_sync(Duration::from_secs(2)).unwrap();
        assert!(!worker.is_loaded());
        assert_eq!(worker.status(), WorkerStatus::Unloaded);

        worker.shutdown();
    }

    #[test]
    fn test_worker_thread_cancellation() {
        let mock = MockInferenceBackend::new().with_delay(Duration::from_millis(10));
        let mut worker = InferenceWorkerHandle::spawn(Box::new(mock)).unwrap();

        let profile = ModelProfile::new("Worker Cancel Model", PathBuf::from("mock.gguf"), 4096);
        worker.load_model_sync(profile, Duration::from_secs(2)).unwrap();

        let event_rx = worker
            .start_generation(
                "Why does my smaller model fail on long inputs?".to_string(),
                GenerationConfig {
                    max_tokens: 1000,
                    ..Default::default()
                },
            )
            .unwrap();

        // Wait for first token then cancel immediately
        let first_event = event_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(matches!(first_event, GenerationEvent::Token(_)));

        // Call cancel
        worker.cancel_generation();

        // Check subsequent events for Cancelled
        let mut saw_cancelled = false;
        while let Ok(event) = event_rx.recv_timeout(Duration::from_secs(1)) {
            if matches!(event, GenerationEvent::Cancelled) {
                saw_cancelled = true;
                break;
            }
        }
        assert!(saw_cancelled);

        // Model remains loaded and ready for next turn
        assert!(worker.is_loaded());

        worker.shutdown();
    }

    #[test]
    fn test_worker_backend_switching() {
        let mut worker = InferenceWorkerHandle::spawn_mock().unwrap();
        assert!(!worker.is_loaded());

        // Switch to LM Studio backend
        worker.switch_to_lm_studio("http://127.0.0.1:1234/v1").unwrap();
        assert!(!worker.is_loaded());

        // Load model on switched backend
        let profile = ModelProfile::new("LM Studio Qwen", PathBuf::from("local"), 8192);
        let meta = worker.load_model_sync(profile, Duration::from_secs(2)).unwrap();
        assert_eq!(meta.name, "LM Studio Qwen");
        assert!(worker.is_loaded());

        // Switch back to mock backend
        worker.switch_to_mock().unwrap();
        assert!(!worker.is_loaded()); // Unloaded automatically on switch

        worker.shutdown();
    }
}
