//! Cetus WebAssembly binary instrumentation crate.
//!
//! Replaces the high-level `WailParser` entry point of the legacy
//! `shared/wail.min.js` for callers in `src/content/cetus.ts`. Low-level WAIL
//! usage in `src/content/init.ts`, `src/popup/libs/disassembler.ts`, and
//! `src/popup/libs/assembler.ts` remains on the JavaScript side and is tracked
//! in `docs/security-debt.md` S-10.

use wasm_bindgen::prelude::*;

mod error;
mod list;
mod patch;
mod rewrite;
mod watchpoint;

#[cfg(test)]
mod fixtures;

pub use error::WailError;
pub use list::list_function_bodies;
pub use patch::apply_patch;
pub use watchpoint::{instrument_watchpoint, FLAG_FREEZE, FLAG_READ, FLAG_WRITE};

#[wasm_bindgen(js_name = instrumentWatchpoint)]
pub fn js_instrument_watchpoint(
    module: &[u8],
    addr: u32,
    flags: u8,
) -> Result<Vec<u8>, JsValue> {
    instrument_watchpoint(module, addr, flags).map_err(into_js_error)
}

#[wasm_bindgen(js_name = applyPatch)]
pub fn js_apply_patch(module: &[u8], func_index: u32, body: &[u8]) -> Result<Vec<u8>, JsValue> {
    apply_patch(module, func_index, body).map_err(into_js_error)
}

#[wasm_bindgen(js_name = listFunctionBodies)]
pub fn js_list_function_bodies(module: &[u8]) -> Result<JsValue, JsValue> {
    let bodies = list_function_bodies(module).map_err(into_js_error)?;
    let array = js_sys::Array::new();
    for body in bodies {
        let bytes = js_sys::Uint8Array::from(body.as_slice());
        array.push(&bytes);
    }
    Ok(array.into())
}

/// Translate a `WailError` into a JS `Error` carrying a machine-readable
/// `code` property (audit L-2 from Stage 5 pre-audit). Callers can branch
/// on `err.code` instead of regex-matching the human message. The returned
/// value is a real `Error` instance so it stringifies and `instanceof Error`
/// behaves as expected on the JS side.
fn into_js_error(err: WailError) -> JsValue {
    let code = err.code();
    let message = err.to_string();
    let js_err = js_sys::Error::new(&message);
    let _ = js_sys::Reflect::set(
        &js_err,
        &JsValue::from_str("code"),
        &JsValue::from_str(code),
    );
    js_err.into()
}

