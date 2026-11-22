use thiserror::Error;

#[derive(Debug, Error)]
pub enum WailError {
    #[error("input module failed WebAssembly validation: {0}")]
    InvalidModule(String),

    #[error("instrumented output failed WebAssembly validation: {0}")]
    InvalidOutput(String),

    #[error("supplied function body failed WebAssembly validation: {0}")]
    InvalidPatchBody(String),

    #[error("function index {0} not found in module code section (module has {1} functions)")]
    FunctionIndexOutOfRange(u32, u32),

    #[error("failed to parse module: {0}")]
    ParseError(String),

    #[error("invalid watchpoint flags 0x{0:02x}: must be a non-zero subset of FLAG_READ|FLAG_WRITE|FLAG_FREEZE (0x07)")]
    InvalidFlags(u8),

    #[error("patch body size {0} exceeds maximum allowed {1}")]
    PatchBodyTooLarge(usize, usize),
}

impl WailError {
    /// Stable machine-readable identifier suitable for cross-language error
    /// channels (TS `{ type: "instrumentError", code: string, … }` messages).
    pub fn code(&self) -> &'static str {
        match self {
            WailError::InvalidModule(_) => "invalid-module",
            WailError::InvalidOutput(_) => "invalid-output",
            WailError::InvalidPatchBody(_) => "invalid-patch-body",
            WailError::FunctionIndexOutOfRange(_, _) => "func-index-out-of-range",
            WailError::ParseError(_) => "parse-error",
            WailError::InvalidFlags(_) => "invalid-flags",
            WailError::PatchBodyTooLarge(_, _) => "patch-body-too-large",
        }
    }
}

impl From<wasmparser::BinaryReaderError> for WailError {
    fn from(err: wasmparser::BinaryReaderError) -> Self {
        WailError::ParseError(err.to_string())
    }
}
