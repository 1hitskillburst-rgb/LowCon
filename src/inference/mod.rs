pub mod adapter;
pub mod backend;
pub mod error;
pub mod gguf;
pub mod lm_studio;
pub mod mock;
pub mod types;
pub mod worker;

pub use adapter::NativeInferenceBackend;
pub use backend::InferenceBackend;
pub use error::InferenceError;
pub use gguf::{
    create_mock_gguf_bytes, detect_quantization_from_filename, file_type_to_quantization,
    parse_gguf_file, parse_gguf_metadata, GgufValue,
};
pub use lm_studio::{
    is_local_endpoint, parse_sse_line, LmStudioBackend, DEFAULT_LM_STUDIO_ENDPOINT,
};
pub use mock::MockInferenceBackend;
pub use types::{
    GenerationConfig, GenerationEvent, ModelMetadata, StopReason, WorkerStatus,
};
pub use worker::{InferenceWorkerHandle, WorkerCommand};
