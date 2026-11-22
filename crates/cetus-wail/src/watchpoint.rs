use wasm_encoder::reencode::{Reencode, RoundtripReencoder};
use wasm_encoder::{BlockType, CodeSection, Function, Instruction, MemArg, Module};
use wasmparser::{Operator, Parser, Payload, TypeRef};

use crate::error::WailError;
use crate::rewrite::{copy_raw_section, section_id_and_range};

/// Read-flag bit in the watchpoint flags byte.
pub const FLAG_READ: u8 = 0x01;
/// Write-flag bit in the watchpoint flags byte.
pub const FLAG_WRITE: u8 = 0x02;
/// Freeze-flag bit (recognised but not enforced by this crate).
pub const FLAG_FREEZE: u8 = 0x04;

const WP_IMPORT_MODULE: &str = "cetus";
const WP_IMPORT_NAME: &str = "watchpoint";

/// Insert a watchpoint at the given linear-memory `addr` with the given `flags`
/// into the supplied WebAssembly module. Returns the rewritten module bytes.
///
/// The input module MUST already import `(cetus.watchpoint (func (param i32 i32)))`;
/// the instrumented module calls that import whenever an instrumented memory
/// access targets `addr`.
///
/// Flag bits:
/// - `FLAG_READ` (`0x01`) — instrument `i32.load`
/// - `FLAG_WRITE` (`0x02`) — instrument `i32.store`
/// - `FLAG_FREEZE` (`0x04`) — accepted, currently a no-op
///
/// Note (Stage 5 narrow scope): only `i32.load` / `i32.store` are instrumented.
/// Wider opcode coverage (i64, f32/f64, sub-byte stores, atomics) is deferred
/// to the `harden-cetus-runtime` change — see `docs/security-debt.md` S-10.
/// Mask of all recognised flag bits (`FLAG_READ | FLAG_WRITE | FLAG_FREEZE`).
const VALID_FLAGS_MASK: u8 = FLAG_READ | FLAG_WRITE | FLAG_FREEZE;

pub fn instrument_watchpoint(
    module: &[u8],
    addr: u32,
    flags: u8,
) -> Result<Vec<u8>, WailError> {
    // Audit M-2 (Stage 5): reject 0-flags silent no-op and unknown bits.
    // Caller almost certainly has a bug if they pass either.
    if flags == 0 || (flags & !VALID_FLAGS_MASK) != 0 {
        return Err(WailError::InvalidFlags(flags));
    }
    wasmparser::validate(module).map_err(|e| WailError::InvalidModule(e.to_string()))?;

    let info = collect_module_info(module)?;
    let wp_fn_idx = info
        .wp_fn_idx
        .ok_or_else(|| WailError::ParseError(format!(
            "watchpoint import '{WP_IMPORT_MODULE}.{WP_IMPORT_NAME}' (func (param i32 i32)) not found in module"
        )))?;

    let mut output = Module::new();
    let mut pending_code: Option<CodeSection> = None;
    let mut current_func_local_idx: u32 = 0;

    for payload in Parser::new(0).parse_all(module) {
        let payload = payload?;
        match payload {
            Payload::Version { .. } => {}
            Payload::End(_) => break,
            Payload::CodeSectionStart { .. } => {
                pending_code = Some(CodeSection::new());
                current_func_local_idx = 0;
            }
            Payload::CodeSectionEntry(body) => {
                let func = instrument_function_body(
                    body,
                    current_func_local_idx,
                    &info,
                    addr,
                    flags,
                    wp_fn_idx,
                )?;
                pending_code
                    .as_mut()
                    .expect("CodeSectionEntry without CodeSectionStart")
                    .function(&func);
                current_func_local_idx += 1;
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
    wasmparser::validate(&bytes).map_err(|e| WailError::InvalidOutput(e.to_string()))?;
    Ok(bytes)
}

struct ModuleInfo {
    /// type index -> (param count, result count)
    type_param_counts: Vec<u32>,
    /// local function index -> type index
    func_types: Vec<u32>,
    /// imported function index of `cetus.watchpoint`, if present
    wp_fn_idx: Option<u32>,
}

fn collect_module_info(module: &[u8]) -> Result<ModuleInfo, WailError> {
    let mut type_param_counts = Vec::new();
    let mut func_types = Vec::new();
    let mut wp_fn_idx = None;
    let mut imported_func_count: u32 = 0;

    for payload in Parser::new(0).parse_all(module) {
        let payload = payload?;
        match payload {
            Payload::TypeSection(reader) => {
                for rec_group in reader {
                    let rec_group = rec_group?;
                    for sub_ty in rec_group.into_types() {
                        let params = match &sub_ty.composite_type.inner {
                            wasmparser::CompositeInnerType::Func(ft) => ft.params().len() as u32,
                            _ => 0,
                        };
                        type_param_counts.push(params);
                    }
                }
            }
            Payload::ImportSection(reader) => {
                for import in reader {
                    let import = import?;
                    if let TypeRef::Func(type_idx) = import.ty {
                        if import.module == WP_IMPORT_MODULE && import.name == WP_IMPORT_NAME {
                            // Validate signature: (param i32 i32) -> ()
                            let pc = type_param_counts.get(type_idx as usize).copied().ok_or_else(
                                || WailError::ParseError("watchpoint import type out of range".into()),
                            )?;
                            if pc != 2 {
                                return Err(WailError::ParseError(format!(
                                    "watchpoint import '{WP_IMPORT_MODULE}.{WP_IMPORT_NAME}' has wrong arity (got {pc} params, want 2)"
                                )));
                            }
                            wp_fn_idx = Some(imported_func_count);
                        }
                        imported_func_count += 1;
                    }
                }
            }
            Payload::FunctionSection(reader) => {
                for type_idx in reader {
                    func_types.push(type_idx?);
                }
            }
            _ => {}
        }
    }

    Ok(ModuleInfo {
        type_param_counts,
        func_types,
        wp_fn_idx,
    })
}

fn instrument_function_body(
    body: wasmparser::FunctionBody<'_>,
    local_func_idx: u32,
    info: &ModuleInfo,
    watch_addr: u32,
    flags: u8,
    wp_fn_idx: u32,
) -> Result<Function, WailError> {
    let type_idx = info
        .func_types
        .get(local_func_idx as usize)
        .copied()
        .ok_or_else(|| {
            WailError::ParseError(format!(
                "no function-section entry for local function index {local_func_idx}"
            ))
        })?;
    let param_count = info
        .type_param_counts
        .get(type_idx as usize)
        .copied()
        .ok_or_else(|| WailError::ParseError(format!("no type at index {type_idx}")))?;

    let mut locals: Vec<(u32, wasm_encoder::ValType)> = Vec::new();
    let mut existing_local_count: u32 = 0;
    let locals_reader = body.get_locals_reader()?;
    for entry in locals_reader {
        let (count, ty) = entry?;
        let encoded = RoundtripReencoder
            .val_type(ty)
            .map_err(|e| WailError::ParseError(format!("val type translation: {e:?}")))?;
        locals.push((count, encoded));
        existing_local_count += count;
    }

    // Append 2 temporary i32 locals at the end for watchpoint instrumentation.
    locals.push((2, wasm_encoder::ValType::I32));
    let tmp_val_idx = param_count + existing_local_count;
    let tmp_addr_idx = tmp_val_idx + 1;

    let mut func = Function::new(locals);

    let mut ops_reader = body.get_operators_reader()?;
    while !ops_reader.eof() {
        let op = ops_reader.read()?;
        emit_instrumented_op(
            &mut func,
            op,
            watch_addr,
            flags,
            wp_fn_idx,
            tmp_val_idx,
            tmp_addr_idx,
        )?;
    }

    Ok(func)
}

fn emit_instrumented_op<'a>(
    func: &mut Function,
    op: Operator<'a>,
    watch_addr: u32,
    flags: u8,
    wp_fn_idx: u32,
    tmp_val_idx: u32,
    tmp_addr_idx: u32,
) -> Result<(), WailError> {
    match op {
        Operator::I32Store { memarg } if flags & FLAG_WRITE != 0 => {
            let mem_arg = encode_memarg(memarg);
            // Stack on entry: [addr, value]
            func.instruction(&Instruction::LocalSet(tmp_val_idx));
            func.instruction(&Instruction::LocalTee(tmp_addr_idx));
            // Stack: [addr]
            if memarg.offset != 0 {
                func.instruction(&Instruction::I32Const(memarg.offset as i32));
                func.instruction(&Instruction::I32Add);
            }
            func.instruction(&Instruction::I32Const(watch_addr as i32));
            func.instruction(&Instruction::I32Eq);
            func.instruction(&Instruction::If(BlockType::Empty));
            func.instruction(&Instruction::LocalGet(tmp_addr_idx));
            if memarg.offset != 0 {
                func.instruction(&Instruction::I32Const(memarg.offset as i32));
                func.instruction(&Instruction::I32Add);
            }
            func.instruction(&Instruction::I32Const(flags as i32));
            func.instruction(&Instruction::Call(wp_fn_idx));
            func.instruction(&Instruction::End);
            func.instruction(&Instruction::LocalGet(tmp_addr_idx));
            func.instruction(&Instruction::LocalGet(tmp_val_idx));
            func.instruction(&Instruction::I32Store(mem_arg));
        }
        Operator::I32Load { memarg } if flags & FLAG_READ != 0 => {
            let mem_arg = encode_memarg(memarg);
            // Stack on entry: [addr]
            func.instruction(&Instruction::LocalTee(tmp_addr_idx));
            if memarg.offset != 0 {
                func.instruction(&Instruction::I32Const(memarg.offset as i32));
                func.instruction(&Instruction::I32Add);
            }
            func.instruction(&Instruction::I32Const(watch_addr as i32));
            func.instruction(&Instruction::I32Eq);
            func.instruction(&Instruction::If(BlockType::Empty));
            func.instruction(&Instruction::LocalGet(tmp_addr_idx));
            if memarg.offset != 0 {
                func.instruction(&Instruction::I32Const(memarg.offset as i32));
                func.instruction(&Instruction::I32Add);
            }
            func.instruction(&Instruction::I32Const(flags as i32));
            func.instruction(&Instruction::Call(wp_fn_idx));
            func.instruction(&Instruction::End);
            func.instruction(&Instruction::LocalGet(tmp_addr_idx));
            func.instruction(&Instruction::I32Load(mem_arg));
        }
        other => {
            let translated = RoundtripReencoder
                .instruction(other)
                .map_err(|e| WailError::ParseError(format!("instruction translation: {e:?}")))?;
            func.instruction(&translated);
        }
    }
    Ok(())
}

fn encode_memarg(memarg: wasmparser::MemArg) -> MemArg {
    MemArg {
        offset: memarg.offset,
        align: memarg.align as u32,
        memory_index: memarg.memory,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::store_at_module;
    use wasmi::{Caller, Engine, Func, Linker, Module as WasmiModule, Store};

    fn run_store(instrumented: &[u8], target_addr: i32, store_value: i32) -> u32 {
        let engine = Engine::default();
        let module = WasmiModule::new(&engine, instrumented).expect("module compiles");
        let mut store = Store::new(&engine, 0u32);

        let watchpoint = Func::wrap(
            &mut store,
            move |mut caller: Caller<'_, u32>, _addr: i32, _flags: i32| {
                *caller.data_mut() += 1;
            },
        );

        let mut linker = Linker::new(&engine);
        linker
            .define("cetus", "watchpoint", watchpoint)
            .expect("define import");
        let instance = linker
            .instantiate(&mut store, &module)
            .expect("instantiate")
            .start(&mut store)
            .expect("start");

        let store_at = instance
            .get_typed_func::<(i32, i32), ()>(&store, "store_at")
            .expect("export store_at");
        store_at
            .call(&mut store, (target_addr, store_value))
            .expect("call store_at");

        *store.data()
    }

    #[test]
    fn write_watchpoint_fires_when_target_address_is_written() {
        let bytes = store_at_module();
        wasmparser::validate(&bytes).expect("fixture is valid");

        let instrumented =
            instrument_watchpoint(&bytes, 0x100, FLAG_WRITE).expect("instrumentation succeeds");
        wasmparser::validate(&instrumented).expect("instrumented module is valid");

        let hits = run_store(&instrumented, 0x100, 42);
        assert!(hits >= 1, "watchpoint should fire at least once, got {hits}");
    }

    #[test]
    fn write_watchpoint_does_not_fire_on_other_address() {
        let bytes = store_at_module();
        let instrumented =
            instrument_watchpoint(&bytes, 0x100, FLAG_WRITE).expect("instrumentation succeeds");

        let hits = run_store(&instrumented, 0x200, 42);
        assert_eq!(hits, 0, "watchpoint should not fire on mismatched address");
    }

    #[test]
    fn zero_flags_is_rejected() {
        let bytes = store_at_module();
        let err = instrument_watchpoint(&bytes, 0x100, 0).expect_err("flags=0 must error");
        match err {
            WailError::InvalidFlags(0) => {}
            other => panic!("expected InvalidFlags(0), got {other:?}"),
        }
    }

    #[test]
    fn unknown_flags_are_rejected() {
        let bytes = store_at_module();
        let err = instrument_watchpoint(&bytes, 0x100, 0x80)
            .expect_err("flags with unknown bits must error");
        match err {
            WailError::InvalidFlags(0x80) => {}
            other => panic!("expected InvalidFlags(0x80), got {other:?}"),
        }
    }

    #[test]
    fn missing_watchpoint_import_returns_error() {
        // Build a tiny module with no imports at all.
        use wasm_encoder::{
            CodeSection, ExportKind, ExportSection, Function as EncFunction, FunctionSection,
            Instruction as EncInst, MemorySection, MemoryType, Module as EncModule, TypeSection,
            ValType,
        };
        let mut module = EncModule::new();
        let mut types = TypeSection::new();
        types.ty().function([ValType::I32, ValType::I32], []);
        module.section(&types);
        let mut functions = FunctionSection::new();
        functions.function(0);
        module.section(&functions);
        let mut memories = MemorySection::new();
        memories.memory(MemoryType {
            minimum: 1,
            maximum: None,
            memory64: false,
            shared: false,
            page_size_log2: None,
        });
        module.section(&memories);
        let mut exports = ExportSection::new();
        exports.export("store_at", ExportKind::Func, 0);
        module.section(&exports);
        let mut code = CodeSection::new();
        let mut f = EncFunction::new(vec![]);
        f.instruction(&EncInst::LocalGet(0));
        f.instruction(&EncInst::LocalGet(1));
        f.instruction(&EncInst::I32Store(wasm_encoder::MemArg {
            offset: 0,
            align: 2,
            memory_index: 0,
        }));
        f.instruction(&EncInst::End);
        code.function(&f);
        module.section(&code);
        let bytes = module.finish();
        wasmparser::validate(&bytes).expect("fixture without import is still valid wasm");

        let err = instrument_watchpoint(&bytes, 0x100, FLAG_WRITE)
            .expect_err("should fail without import");
        assert!(
            err.to_string().contains("watchpoint import"),
            "error should mention missing import, got: {err}"
        );
    }
}
