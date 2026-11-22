use crate::error::WailError;

/// Return the raw body bytes of every function defined in the module's code
/// section, in module order. The returned `Vec<Vec<u8>>` is indexed by the
/// function's code-section index (i.e. the i-th element is the body of the
/// i-th defined function, NOT accounting for imported functions).
pub fn list_function_bodies(_module: &[u8]) -> Result<Vec<Vec<u8>>, WailError> {
    Err(WailError::ParseError(
        "list_function_bodies not yet implemented".to_string(),
    ))
}
