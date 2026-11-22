//! Shared helpers for module-rewriting pipelines (watchpoint, patch).

use std::ops::Range;

use wasm_encoder::{Module, RawSection};
use wasmparser::Payload;

/// Map a wasmparser `Payload` describing a section to `(section_id, body_range)`.
/// Returns `None` for non-section payloads (Version, End, CodeSection*).
pub(crate) fn section_id_and_range(payload: &Payload<'_>) -> Option<(u8, Range<usize>)> {
    use wasmparser::Payload as P;
    match payload {
        P::TypeSection(r) => Some((1, r.range())),
        P::ImportSection(r) => Some((2, r.range())),
        P::FunctionSection(r) => Some((3, r.range())),
        P::TableSection(r) => Some((4, r.range())),
        P::MemorySection(r) => Some((5, r.range())),
        P::TagSection(r) => Some((13, r.range())),
        P::GlobalSection(r) => Some((6, r.range())),
        P::ExportSection(r) => Some((7, r.range())),
        P::StartSection { range, .. } => Some((8, range.clone())),
        P::ElementSection(r) => Some((9, r.range())),
        P::DataCountSection { range, .. } => Some((12, range.clone())),
        P::DataSection(r) => Some((11, r.range())),
        P::CustomSection(r) => Some((0, r.range())),
        _ => None,
    }
}

/// Copy a section through to `output` from raw bytes.
pub(crate) fn copy_raw_section(output: &mut Module, id: u8, module_bytes: &[u8], range: Range<usize>) {
    output.section(&RawSection {
        id,
        data: &module_bytes[range],
    });
}
