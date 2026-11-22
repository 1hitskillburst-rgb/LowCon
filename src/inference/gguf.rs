use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use super::error::InferenceError;
use super::types::ModelMetadata;

pub const GGUF_MAGIC: [u8; 4] = [0x47, 0x47, 0x55, 0x46]; // "GGUF" in ASCII
pub const GGUF_VERSION_1: u32 = 1;
pub const GGUF_VERSION_2: u32 = 2;
pub const GGUF_VERSION_3: u32 = 3;

#[derive(Debug, Clone, PartialEq)]
pub enum GgufValue {
    Uint8(u8),
    Int8(i8),
    Uint16(u16),
    Int16(i16),
    Uint32(u32),
    Int32(i32),
    Float32(f32),
    Bool(bool),
    String(String),
    Array(Vec<GgufValue>),
    Uint64(u64),
    Int64(i64),
    Float64(f64),
}

impl GgufValue {
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            GgufValue::Uint8(v) => Some(*v as u64),
            GgufValue::Uint16(v) => Some(*v as u64),
            GgufValue::Uint32(v) => Some(*v as u64),
            GgufValue::Uint64(v) => Some(*v),
            GgufValue::Int8(v) if *v >= 0 => Some(*v as u64),
            GgufValue::Int16(v) if *v >= 0 => Some(*v as u64),
            GgufValue::Int32(v) if *v >= 0 => Some(*v as u64),
            GgufValue::Int64(v) if *v >= 0 => Some(*v as u64),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            GgufValue::String(s) => Some(s.as_str()),
            _ => None,
        }
    }

    pub fn to_display_string(&self) -> String {
        match self {
            GgufValue::Uint8(v) => v.to_string(),
            GgufValue::Int8(v) => v.to_string(),
            GgufValue::Uint16(v) => v.to_string(),
            GgufValue::Int16(v) => v.to_string(),
            GgufValue::Uint32(v) => v.to_string(),
            GgufValue::Int32(v) => v.to_string(),
            GgufValue::Float32(v) => v.to_string(),
            GgufValue::Bool(v) => v.to_string(),
            GgufValue::String(v) => v.clone(),
            GgufValue::Array(items) => format!("[{} items]", items.len()),
            GgufValue::Uint64(v) => v.to_string(),
            GgufValue::Int64(v) => v.to_string(),
            GgufValue::Float64(v) => v.to_string(),
        }
    }
}

/// Parse metadata from a local .gguf file.
pub fn parse_gguf_file(path: &Path) -> Result<ModelMetadata, InferenceError> {
    if !path.exists() {
        return Err(InferenceError::FileNotFound(path.to_path_buf()));
    }

    let file = File::open(path)?;
    let file_size = file.metadata()?.len();
    let mut reader = BufReader::new(file);

    let default_name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown_model")
        .to_string();

    let mut metadata = parse_gguf_metadata(&mut reader, file_size, &default_name)?;

    // If quantization is unknown, try to detect it from the filename
    if metadata.quantization == "Unknown" {
        if let Some(filename) = path.file_name().and_then(|s| s.to_str()) {
            if let Some(detected) = detect_quantization_from_filename(filename) {
                metadata.quantization = detected.to_string();
            }
        }
    }

    Ok(metadata)
}

/// Parse metadata from any Read + Seek stream.
pub fn parse_gguf_metadata<R: Read + Seek>(
    reader: &mut R,
    file_size: u64,
    default_name: &str,
) -> Result<ModelMetadata, InferenceError> {
    // 1. Check Magic bytes
    let mut magic = [0u8; 4];
    reader.read_exact(&mut magic)?;
    if magic != GGUF_MAGIC {
        return Err(InferenceError::InvalidGgufFormat(format!(
            "Expected magic 'GGUF', found {:?}",
            magic
        )));
    }

    // 2. Version
    let mut version_buf = [0u8; 4];
    reader.read_exact(&mut version_buf)?;
    let version = u32::from_le_bytes(version_buf);
    if version != GGUF_VERSION_1 && version != GGUF_VERSION_2 && version != GGUF_VERSION_3 {
        return Err(InferenceError::UnsupportedGgufVersion(version));
    }

    // 3. Tensor count and metadata KV count
    let tensor_count = read_u64_or_u32(reader, version)?;
    let metadata_kv_count = read_u64_or_u32(reader, version)?;

    if metadata_kv_count > 100_000 {
        return Err(InferenceError::CorruptHeader(format!(
            "Unreasonably large metadata KV count: {}",
            metadata_kv_count
        )));
    }

    // 4. Read metadata key-value pairs
    let mut kv_map: HashMap<String, GgufValue> = HashMap::with_capacity(metadata_kv_count as usize);

    for _ in 0..metadata_kv_count {
        let key = read_gguf_string(reader, version)?;
        let mut val_type_buf = [0u8; 4];
        reader.read_exact(&mut val_type_buf)?;
        let val_type = u32::from_le_bytes(val_type_buf);

        let value = read_gguf_value(reader, val_type, &key, version)?;
        kv_map.insert(key, value);
    }

    // 5. Extract structured fields from metadata map
    let architecture = kv_map
        .get("general.architecture")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| {
            // Try to deduce architecture from keys like "<arch>.context_length"
            for key in kv_map.keys() {
                if let Some(arch) = key.strip_suffix(".context_length") {
                    return arch;
                }
            }
            "unknown"
        })
        .to_string();

    let name = kv_map
        .get("general.name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| default_name.to_string());

    // Context length: check <arch>.context_length, then *.context_length, then general.context_length
    let context_key = format!("{}.context_length", architecture);
    let context_length = kv_map
        .get(&context_key)
        .and_then(|v| v.as_u64())
        .or_else(|| {
            kv_map
                .iter()
                .find(|(k, _)| k.ends_with(".context_length"))
                .and_then(|(_, v)| v.as_u64())
        })
        .or_else(|| kv_map.get("general.context_length").and_then(|v| v.as_u64()))
        .unwrap_or(2048) as usize;

    // Quantization from general.file_type
    let quantization = kv_map
        .get("general.file_type")
        .and_then(|v| v.as_u64())
        .map(|ft| file_type_to_quantization(ft as u32).to_string())
        .or_else(|| {
            kv_map
                .get("general.quantization_version")
                .map(|_| "Quantized".to_string())
        })
        .unwrap_or_else(|| "Unknown".to_string());

    // Embedding length
    let emb_key = format!("{}.embedding_length", architecture);
    let embedding_length = kv_map
        .get(&emb_key)
        .and_then(|v| v.as_u64())
        .map(|v| v as usize);

    // Block count (layers)
    let block_key = format!("{}.block_count", architecture);
    let block_count = kv_map
        .get(&block_key)
        .and_then(|v| v.as_u64())
        .map(|v| v as usize);

    // Chat template
    let chat_template = kv_map
        .get("tokenizer.chat_template")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Description
    let description = kv_map
        .get("general.description")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Convert other key-values to display string map
    let mut extra_kv = HashMap::new();
    for (k, v) in kv_map {
        extra_kv.insert(k, v.to_display_string());
    }

    Ok(ModelMetadata {
        name,
        architecture,
        quantization,
        context_length,
        file_size_bytes: file_size,
        tensor_count,
        embedding_length,
        block_count,
        chat_template,
        description,
        extra_kv,
    })
}

fn read_u64_or_u32<R: Read>(reader: &mut R, version: u32) -> Result<u64, InferenceError> {
    if version == GGUF_VERSION_1 {
        let mut buf = [0u8; 4];
        reader.read_exact(&mut buf)?;
        Ok(u32::from_le_bytes(buf) as u64)
    } else {
        let mut buf = [0u8; 8];
        reader.read_exact(&mut buf)?;
        Ok(u64::from_le_bytes(buf))
    }
}

fn read_gguf_string<R: Read>(reader: &mut R, version: u32) -> Result<String, InferenceError> {
    let len = read_u64_or_u32(reader, version)?;
    if len > 10 * 1024 * 1024 {
        return Err(InferenceError::CorruptHeader(format!(
            "String length {} exceeds 10MB limit",
            len
        )));
    }
    let mut bytes = vec![0u8; len as usize];
    reader.read_exact(&mut bytes)?;
    String::from_utf8(bytes).map_err(|e| {
        InferenceError::CorruptHeader(format!("String is not valid UTF-8: {}", e))
    })
}

fn read_gguf_value<R: Read + Seek>(
    reader: &mut R,
    val_type: u32,
    key: &str,
    version: u32,
) -> Result<GgufValue, InferenceError> {
    match val_type {
        0 => {
            let mut buf = [0u8; 1];
            reader.read_exact(&mut buf)?;
            Ok(GgufValue::Uint8(buf[0]))
        }
        1 => {
            let mut buf = [0u8; 1];
            reader.read_exact(&mut buf)?;
            Ok(GgufValue::Int8(buf[0] as i8))
        }
        2 => {
            let mut buf = [0u8; 2];
            reader.read_exact(&mut buf)?;
            Ok(GgufValue::Uint16(u16::from_le_bytes(buf)))
        }
        3 => {
            let mut buf = [0u8; 2];
            reader.read_exact(&mut buf)?;
            Ok(GgufValue::Int16(i16::from_le_bytes(buf)))
        }
        4 => {
            let mut buf = [0u8; 4];
            reader.read_exact(&mut buf)?;
            Ok(GgufValue::Uint32(u32::from_le_bytes(buf)))
        }
        5 => {
            let mut buf = [0u8; 4];
            reader.read_exact(&mut buf)?;
            Ok(GgufValue::Int32(i32::from_le_bytes(buf)))
        }
        6 => {
            let mut buf = [0u8; 4];
            reader.read_exact(&mut buf)?;
            Ok(GgufValue::Float32(f32::from_le_bytes(buf)))
        }
        7 => {
            let mut buf = [0u8; 1];
            reader.read_exact(&mut buf)?;
            Ok(GgufValue::Bool(buf[0] != 0))
        }
        8 => {
            let s = read_gguf_string(reader, version)?;
            Ok(GgufValue::String(s))
        }
        9 => {
            // Array
            let mut elem_type_buf = [0u8; 4];
            reader.read_exact(&mut elem_type_buf)?;
            let elem_type = u32::from_le_bytes(elem_type_buf);
            let array_len = read_u64_or_u32(reader, version)?;

            // If it's a huge array (e.g. tokenizer tokens array of 128k items), seek past it to avoid multi-MB allocation
            if (key.ends_with(".tokens") || array_len > 2000) && elem_type == 8 {
                for _ in 0..array_len {
                    let str_len = read_u64_or_u32(reader, version)?;
                    reader.seek(SeekFrom::Current(str_len as i64))?;
                }
                return Ok(GgufValue::Array(vec![GgufValue::String(format!(
                    "[{} strings skipped]",
                    array_len
                ))]));
            }

            // For other large primitive arrays, seek past if > 5000 items
            if array_len > 5000 {
                let elem_size = match elem_type {
                    0 | 1 | 7 => 1,
                    2 | 3 => 2,
                    4 | 5 | 6 => 4,
                    10 | 11 | 12 => 8,
                    _ => 4,
                };
                reader.seek(SeekFrom::Current((array_len * elem_size) as i64))?;
                return Ok(GgufValue::Array(vec![GgufValue::String(format!(
                    "[{} items skipped]",
                    array_len
                ))]));
            }

            let mut items = Vec::with_capacity(array_len.min(1000) as usize);
            for _ in 0..array_len {
                items.push(read_gguf_value(reader, elem_type, key, version)?);
            }
            Ok(GgufValue::Array(items))
        }
        10 => {
            let mut buf = [0u8; 8];
            reader.read_exact(&mut buf)?;
            Ok(GgufValue::Uint64(u64::from_le_bytes(buf)))
        }
        11 => {
            let mut buf = [0u8; 8];
            reader.read_exact(&mut buf)?;
            Ok(GgufValue::Int64(i64::from_le_bytes(buf)))
        }
        12 => {
            let mut buf = [0u8; 8];
            reader.read_exact(&mut buf)?;
            Ok(GgufValue::Float64(f64::from_le_bytes(buf)))
        }
        _ => Err(InferenceError::CorruptHeader(format!(
            "Unknown GGUF value type {}",
            val_type
        ))),
    }
}

/// Convert GGUF file_type integer enum to standard quantization label.
pub fn file_type_to_quantization(file_type: u32) -> &'static str {
    match file_type {
        0 => "F32",
        1 => "F16",
        2 => "Q4_0",
        3 => "Q4_1",
        7 => "Q8_0",
        8 => "Q5_0",
        9 => "Q5_1",
        10 => "Q2_K",
        11 => "Q3_K_S",
        12 => "Q3_K_M",
        13 => "Q3_K_L",
        14 => "Q4_K_S",
        15 => "Q4_K_M",
        16 => "Q5_K_S",
        17 => "Q5_K_M",
        18 => "Q6_K",
        19 => "IQ2_XXS",
        20 => "IQ2_XS",
        21 => "Q2_K_S",
        22 => "IQ3_XS",
        23 => "IQ3_XXS",
        24 => "IQ1_S",
        25 => "IQ4_NL",
        26 => "IQ3_S",
        27 => "IQ3_M",
        28 => "IQ2_S",
        29 => "IQ2_M",
        30 => "IQ4_XS",
        31 => "IQ1_M",
        32 => "BF16",
        33 => "Q4_0_4_4",
        34 => "Q4_0_4_8",
        35 => "Q4_0_8_8",
        _ => "Unknown",
    }
}

/// Detect quantization scheme from typical GGUF filenames when file_type is missing.
pub fn detect_quantization_from_filename(filename: &str) -> Option<&'static str> {
    let lower = filename.to_lowercase();
    let candidates = [
        ("q4_k_m", "Q4_K_M"),
        ("q4_k_s", "Q4_K_S"),
        ("q5_k_m", "Q5_K_M"),
        ("q5_k_s", "Q5_K_S"),
        ("q6_k", "Q6_K"),
        ("q8_0", "Q8_0"),
        ("q4_0", "Q4_0"),
        ("q4_1", "Q4_1"),
        ("q5_0", "Q5_0"),
        ("q5_1", "Q5_1"),
        ("q2_k", "Q2_K"),
        ("q3_k_m", "Q3_K_M"),
        ("q3_k_s", "Q3_K_S"),
        ("q3_k_l", "Q3_K_L"),
        ("iq4_nl", "IQ4_NL"),
        ("iq3_m", "IQ3_M"),
        ("iq2_xxs", "IQ2_XXS"),
        ("bf16", "BF16"),
        ("f16", "F16"),
        ("f32", "F32"),
    ];

    for (needle, label) in candidates {
        if lower.contains(needle) {
            return Some(label);
        }
    }
    None
}

/// Helper function to create valid in-memory GGUF bytes for testing.
pub fn create_mock_gguf_bytes(
    architecture: &str,
    name: &str,
    context_length: u32,
    file_type: u32,
    chat_template: Option<&str>,
) -> Vec<u8> {
    let mut out = Vec::new();
    // 1. Magic
    out.extend_from_slice(&GGUF_MAGIC);
    // 2. Version 3
    out.extend_from_slice(&3u32.to_le_bytes());
    // 3. Tensor count
    out.extend_from_slice(&128u64.to_le_bytes());

    // Compute metadata count
    let mut kv_count = 4u64; // arch, name, context_len, file_type
    if chat_template.is_some() {
        kv_count += 1;
    }
    out.extend_from_slice(&kv_count.to_le_bytes());

    // KV 1: general.architecture (type 8 = string)
    write_test_kv_string(&mut out, "general.architecture", architecture);

    // KV 2: general.name (type 8 = string)
    write_test_kv_string(&mut out, "general.name", name);

    // KV 3: <arch>.context_length (type 4 = uint32)
    let ctx_key = format!("{}.context_length", architecture);
    write_test_kv_u32(&mut out, &ctx_key, context_length);

    // KV 4: general.file_type (type 4 = uint32)
    write_test_kv_u32(&mut out, "general.file_type", file_type);

    // KV 5: tokenizer.chat_template (optional)
    if let Some(tpl) = chat_template {
        write_test_kv_string(&mut out, "tokenizer.chat_template", tpl);
    }

    out
}

fn write_test_kv_string(out: &mut Vec<u8>, key: &str, value: &str) {
    // Key length + key
    out.extend_from_slice(&(key.len() as u64).to_le_bytes());
    out.extend_from_slice(key.as_bytes());
    // Type 8 = string
    out.extend_from_slice(&8u32.to_le_bytes());
    // Value length + value
    out.extend_from_slice(&(value.len() as u64).to_le_bytes());
    out.extend_from_slice(value.as_bytes());
}

fn write_test_kv_u32(out: &mut Vec<u8>, key: &str, value: u32) {
    out.extend_from_slice(&(key.len() as u64).to_le_bytes());
    out.extend_from_slice(key.as_bytes());
    // Type 4 = uint32
    out.extend_from_slice(&4u32.to_le_bytes());
    out.extend_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn test_parse_valid_gguf_mock() {
        let bytes = create_mock_gguf_bytes("llama", "Llama-3-8B-Instruct", 8192, 15, Some("{{ messages }}"));
        let mut cursor = Cursor::new(bytes);
        let meta = parse_gguf_metadata(&mut cursor, 4_000_000_000, "default").unwrap();

        assert_eq!(meta.name, "Llama-3-8B-Instruct");
        assert_eq!(meta.architecture, "llama");
        assert_eq!(meta.context_length, 8192);
        assert_eq!(meta.quantization, "Q4_K_M");
        assert_eq!(meta.tensor_count, 128);
        assert_eq!(meta.chat_template.as_deref(), Some("{{ messages }}"));
    }

    #[test]
    fn test_invalid_magic_fails() {
        let mut bytes = create_mock_gguf_bytes("llama", "Test", 4096, 7, None);
        bytes[0] = b'B'; // Corrupt magic
        let mut cursor = Cursor::new(bytes);
        let err = parse_gguf_metadata(&mut cursor, 1000, "default").unwrap_err();

        match err {
            InferenceError::InvalidGgufFormat(msg) => {
                assert!(msg.contains("Expected magic 'GGUF'"));
            }
            other => panic!("Unexpected error: {:?}", other),
        }
    }

    #[test]
    fn test_unsupported_version_fails() {
        let mut bytes = create_mock_gguf_bytes("llama", "Test", 4096, 7, None);
        bytes[4] = 99; // Version 99
        let mut cursor = Cursor::new(bytes);
        let err = parse_gguf_metadata(&mut cursor, 1000, "default").unwrap_err();

        match err {
            InferenceError::UnsupportedGgufVersion(99) => (),
            other => panic!("Unexpected error: {:?}", other),
        }
    }

    #[test]
    fn test_truncated_file_fails() {
        let bytes = create_mock_gguf_bytes("llama", "Test", 4096, 7, None);
        let truncated = &bytes[0..12]; // Cut off mid-header
        let mut cursor = Cursor::new(truncated);
        assert!(parse_gguf_metadata(&mut cursor, 12, "default").is_err());
    }

    #[test]
    fn test_quantization_detection_from_filename() {
        assert_eq!(detect_quantization_from_filename("qwen2.5-7b-instruct-q4_k_m.gguf"), Some("Q4_K_M"));
        assert_eq!(detect_quantization_from_filename("llama-3-8b-q8_0.gguf"), Some("Q8_0"));
        assert_eq!(detect_quantization_from_filename("mistral-7b-instruct-v0.2.Q5_K_M.gguf"), Some("Q5_K_M"));
        assert_eq!(detect_quantization_from_filename("model-f16.gguf"), Some("F16"));
        assert_eq!(detect_quantization_from_filename("unknown-weights.bin"), None);
    }
}
