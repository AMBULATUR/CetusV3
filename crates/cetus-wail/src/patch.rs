use wasm_encoder::{CodeSection, Module};
use wasmparser::{Parser, Payload, TypeRef};

use crate::error::WailError;
use crate::rewrite::{copy_raw_section, section_id_and_range};

/// Maximum permitted size for a replacement function body, in bytes. A
/// realistic legitimate body is a few KB at most; an order-of-magnitude cap
/// here prevents a hostile or malformed patch from OOM-ing the service worker
/// (audit L-1 from Stage 5 pre-audit). Reuse of the constant intentionally
/// matches existing patch-storage assumptions in popup.
pub const MAX_PATCH_BODY_SIZE: usize = 1 << 20; // 1 MiB

/// Replace the function body at module-relative `func_index` (counting imports
/// first, then locally-defined functions) with `body`. Returns the rewritten
/// module bytes on success, or `WailError::InvalidPatchBody` if the resulting
/// module fails WebAssembly validation. The output module is never emitted
/// when validation fails — the caller can rely on either getting a valid
/// module back or an error, never a half-applied module.
pub fn apply_patch(module: &[u8], func_index: u32, body: &[u8]) -> Result<Vec<u8>, WailError> {
    if body.len() > MAX_PATCH_BODY_SIZE {
        return Err(WailError::PatchBodyTooLarge(body.len(), MAX_PATCH_BODY_SIZE));
    }
    wasmparser::validate(module).map_err(|e| WailError::InvalidModule(e.to_string()))?;

    let (imported_func_count, local_func_count) = count_functions(module)?;
    let total = imported_func_count + local_func_count;
    if func_index < imported_func_count || func_index >= total {
        return Err(WailError::FunctionIndexOutOfRange(func_index, total));
    }
    let target_local_idx = func_index - imported_func_count;

    let mut output = Module::new();
    let mut pending_code: Option<CodeSection> = None;
    let mut current_local_idx: u32 = 0;

    for payload in Parser::new(0).parse_all(module) {
        let payload = payload?;
        match payload {
            Payload::Version { .. } => {}
            Payload::End(_) => break,
            Payload::CodeSectionStart { .. } => {
                pending_code = Some(CodeSection::new());
                current_local_idx = 0;
            }
            Payload::CodeSectionEntry(body_orig) => {
                let cs = pending_code
                    .as_mut()
                    .expect("CodeSectionEntry without CodeSectionStart");
                if current_local_idx == target_local_idx {
                    cs.raw(body);
                } else {
                    cs.raw(&module[body_orig.range()]);
                }
                current_local_idx += 1;
            }
            other => {
                let Some((id, range)) = section_id_and_range(&other) else {
                    continue;
                };
                if let Some(cs) = pending_code.take() {
                    output.section(&cs);
                }
                copy_raw_section(&mut output, id, module, range);
            }
        }
    }

    if let Some(cs) = pending_code.take() {
        output.section(&cs);
    }

    let bytes = output.finish();
    wasmparser::validate(&bytes).map_err(|e| WailError::InvalidPatchBody(e.to_string()))?;
    Ok(bytes)
}

fn count_functions(module: &[u8]) -> Result<(u32, u32), WailError> {
    let mut imported = 0u32;
    let mut local = 0u32;
    for payload in Parser::new(0).parse_all(module) {
        let payload = payload?;
        match payload {
            Payload::ImportSection(reader) => {
                for import in reader {
                    let import = import?;
                    if let TypeRef::Func(_) = import.ty {
                        imported += 1;
                    }
                }
            }
            Payload::FunctionSection(reader) => {
                for entry in reader {
                    let _ = entry?;
                    local += 1;
                }
            }
            _ => {}
        }
    }
    Ok((imported, local))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::two_func_module;
    use wasmi::{Engine, Linker, Module as WasmiModule, Store};

    /// Body bytes for `(func (param i32) (result i32) local.get 0 local.get 0 i32.add)`
    /// — i.e. doubling the input.
    fn double_body() -> Vec<u8> {
        vec![
            0x00, // 0 local decls
            0x20, 0x00, // local.get 0
            0x20, 0x00, // local.get 0
            0x6A, // i32.add
            0x0B, // end
        ]
    }

    fn run_square(module_bytes: &[u8], input: i32) -> i32 {
        let engine = Engine::default();
        let module = WasmiModule::new(&engine, module_bytes).expect("module compiles");
        let mut store = Store::new(&engine, ());
        let linker = Linker::new(&engine);
        let instance = linker
            .instantiate(&mut store, &module)
            .expect("instantiate")
            .start(&mut store)
            .expect("start");
        let square = instance
            .get_typed_func::<i32, i32>(&store, "square")
            .expect("export square");
        square.call(&mut store, input).expect("call square")
    }

    #[test]
    fn patched_module_validates_and_runs_new_body() {
        let module = two_func_module();
        assert_eq!(run_square(&module, 5), 25, "baseline square(5) = 25");

        let patched = apply_patch(&module, 1, &double_body()).expect("patch applies");
        wasmparser::validate(&patched).expect("patched module is valid");

        assert_eq!(run_square(&patched, 5), 10, "patched square(5) doubles to 10");
    }

    #[test]
    fn invalid_patch_body_returns_error_and_no_module() {
        let module = two_func_module();

        // Garbage body: 0xFF is not a valid opcode in WASM core.
        let invalid_body = vec![0x00, 0xFF, 0x0B];

        let err = apply_patch(&module, 1, &invalid_body)
            .expect_err("invalid body must error");
        match err {
            WailError::InvalidPatchBody(_) => {}
            other => panic!("expected InvalidPatchBody, got {other:?}"),
        }
    }

    #[test]
    fn oversized_body_is_rejected_before_validation() {
        let module = two_func_module();
        let huge = vec![0u8; MAX_PATCH_BODY_SIZE + 1];
        let err = apply_patch(&module, 1, &huge).expect_err("oversized body must error");
        match err {
            WailError::PatchBodyTooLarge(n, cap) => {
                assert_eq!(n, MAX_PATCH_BODY_SIZE + 1);
                assert_eq!(cap, MAX_PATCH_BODY_SIZE);
            }
            other => panic!("expected PatchBodyTooLarge, got {other:?}"),
        }
    }

    #[test]
    fn out_of_range_index_errors() {
        let module = two_func_module();
        let err = apply_patch(&module, 99, &double_body()).expect_err("index out of range");
        match err {
            WailError::FunctionIndexOutOfRange(99, _) => {}
            other => panic!("expected FunctionIndexOutOfRange(99, _), got {other:?}"),
        }
    }
}
