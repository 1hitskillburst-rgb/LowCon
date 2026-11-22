use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::channel;
use std::sync::Arc;
use std::time::Duration;

use lowcon::config::ModelProfile;
use lowcon::inference::{
    create_mock_gguf_bytes, parse_gguf_file, GenerationConfig, GenerationEvent, InferenceBackend,
    InferenceError, InferenceWorkerHandle, MockInferenceBackend, NativeInferenceBackend, StopReason,
    WorkerStatus,
};

#[test]
fn test_gguf_file_parsing_on_disk() {
    let temp_dir = std::env::temp_dir();
    let gguf_path = temp_dir.join(format!("test_model_{}.gguf", uuid::Uuid::new_v4()));

    // Generate valid GGUF bytes with ChatML template and Q4_K_M quantization (file_type = 15)
    let bytes = create_mock_gguf_bytes(
        "qwen2",
        "Qwen2.5-7B-Instruct",
        32768,
        15,
        Some("<|im_start|>system\n{{ messages }}"),
    );

    let mut file = File::create(&gguf_path).expect("Failed to create temp GGUF file");
    file.write_all(&bytes).expect("Failed to write GGUF bytes");
    file.flush().unwrap();
    drop(file);

    // Parse the file from disk
    let metadata = parse_gguf_file(&gguf_path).expect("Failed to parse valid GGUF file");

    assert_eq!(metadata.name, "Qwen2.5-7B-Instruct");
    assert_eq!(metadata.architecture, "qwen2");
    assert_eq!(metadata.context_length, 32768);
    assert_eq!(metadata.quantization, "Q4_K_M");
    assert_eq!(metadata.tensor_count, 128);
    assert!(metadata.chat_template.is_some());

    // Clean up
    let _ = std::fs::remove_file(gguf_path);
}

#[test]
fn test_inference_lifecycle_full() {
    let mut backend = MockInferenceBackend::new();
    assert!(!backend.is_loaded());

    // 1. Load model with 2048 context capacity
    let profile = ModelProfile::new("Llama-3-8B", PathBuf::from("mock_llama.gguf"), 2048);
    let meta = backend.load_model(&profile).expect("Load model failed");
    assert!(backend.is_loaded());
    assert_eq!(meta.context_length, 2048);

    // 2. Token counting
    let count = backend.token_count("The quick brown fox jumps over the lazy dog.").unwrap();
    assert!(count >= 9);

    // 3. Normal streaming generation
    let (tx, rx) = channel();
    let cancel = Arc::new(AtomicBool::new(false));
    let config = GenerationConfig {
        max_tokens: 50,
        ..Default::default()
    };

    backend
        .stream_generate("Explain offline privacy in LowCon", &config, tx, cancel)
        .expect("Stream generation failed");

    let events: Vec<_> = rx.into_iter().collect();
    assert!(!events.is_empty());

    let mut total_tokens = 0;
    let mut saw_complete = false;
    for ev in events {
        match ev {
            GenerationEvent::Token(_) => total_tokens += 1,
            GenerationEvent::Complete { total_tokens: cnt, stop_reason } => {
                assert_eq!(cnt, total_tokens);
                assert!(matches!(stop_reason, StopReason::Done | StopReason::MaxTokens));
                saw_complete = true;
            }
            GenerationEvent::Cancelled => panic!("Did not expect cancel"),
            GenerationEvent::Error(err) => panic!("Unexpected generation error: {}", err),
        }
    }
    assert!(saw_complete);

    // 4. Test max_tokens limit
    let (tx_max, rx_max) = channel();
    let cancel_max = Arc::new(AtomicBool::new(false));
    let config_max = GenerationConfig {
        max_tokens: 5,
        ..Default::default()
    };
    backend
        .stream_generate("Explain offline privacy in LowCon", &config_max, tx_max, cancel_max)
        .expect("Stream generation failed");

    let events_max: Vec<_> = rx_max.into_iter().collect();
    let complete_ev = events_max.last().unwrap();
    match complete_ev {
        GenerationEvent::Complete { total_tokens, stop_reason } => {
            assert_eq!(*total_tokens, 5);
            assert_eq!(*stop_reason, StopReason::MaxTokens);
        }
        other => panic!("Expected complete with MaxTokens, got {:?}", other),
    }

    // 5. Unload model
    backend.unload_model().expect("Unload failed");
    assert!(!backend.is_loaded());
    assert_eq!(backend.get_metadata(), None);

    // 6. Generating when unloaded returns ModelNotLoaded
    let (tx_err, _rx_err) = channel();
    let cancel_err = Arc::new(AtomicBool::new(false));
    let err = backend.stream_generate("test", &config, tx_err, cancel_err).unwrap_err();
    assert_eq!(err, InferenceError::ModelNotLoaded);
}

#[test]
fn test_worker_cancellation_and_status() {
    let mock = MockInferenceBackend::new().with_delay(Duration::from_millis(15));
    let mut worker = InferenceWorkerHandle::spawn(Box::new(mock)).expect("Failed to spawn worker");

    assert_eq!(worker.status(), WorkerStatus::Unloaded);

    let profile = ModelProfile::new("CancelWorkerModel", PathBuf::from("cancel.gguf"), 4096);
    let meta = worker.load_model_sync(profile, Duration::from_secs(2)).expect("Sync load failed");
    assert_eq!(meta.name, "CancelWorkerModel");
    assert!(worker.is_loaded());

    // Start generation
    let rx = worker
        .start_generation(
            "Why does my smaller model lose earlier context?".to_string(),
            GenerationConfig {
                max_tokens: 500,
                ..Default::default()
            },
        )
        .expect("Start generation failed");

    // Wait for at least one token
    let first = rx.recv_timeout(Duration::from_secs(1)).expect("Timed out waiting for first token");
    assert!(matches!(first, GenerationEvent::Token(_)));

    // Cancel immediately
    worker.cancel_generation();

    // Verify cancellation event arrives promptly
    let mut saw_cancel = false;
    while let Ok(event) = rx.recv_timeout(Duration::from_secs(1)) {
        if matches!(event, GenerationEvent::Cancelled) {
            saw_cancel = true;
            break;
        }
    }
    assert!(saw_cancel, "Expected Cancelled event after cancelling generation");

    // Model must still be loaded and intact after cancellation
    assert!(worker.is_loaded());

    // Unload cleanly
    worker.unload_model_sync(Duration::from_secs(2)).expect("Unload failed");
    assert!(!worker.is_loaded());

    worker.shutdown();
}

#[test]
fn test_native_adapter_lifecycle() {
    let mut adapter = NativeInferenceBackend::new();
    let profile = ModelProfile::new("AdapterModel", PathBuf::from("local.gguf"), 4096);

    let meta = adapter.load_model(&profile).expect("Adapter load failed");
    assert_eq!(meta.name, "AdapterModel");
    assert!(adapter.is_loaded());

    let (tx, rx) = channel();
    let cancel = Arc::new(AtomicBool::new(false));
    adapter
        .stream_generate("Tell me about Rust memory management", &GenerationConfig::default(), tx, cancel)
        .expect("Adapter stream generation failed");

    let events: Vec<_> = rx.into_iter().collect();
    assert!(!events.is_empty());
    assert!(matches!(events.last(), Some(GenerationEvent::Complete { .. })));

    adapter.unload_model().expect("Adapter unload failed");
    assert!(!adapter.is_loaded());
}
