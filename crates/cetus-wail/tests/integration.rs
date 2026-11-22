//! End-to-end integration tests for the `cetus-wail` crate.
//!
//! Per design.md §Decisions "Scope narrowing discovered during Stage 4 → 5
//! transition", fixtures are hand-built synthesised WASM modules; the crate
//! deliberately does NOT compare against v1.05 `wail.min.js` reference
//! output for byte-equivalent parity (see `docs/security-debt.md` S-10).

use cetus_wail::{apply_patch, instrument_watchpoint, FLAG_WRITE, WailError};
use wasm_encoder::{
    CodeSection, EntityType, ExportKind, ExportSection, Function, FunctionSection, ImportSection,
    Instruction, MemArg, MemorySection, MemoryType, Module, TypeSection, ValType,
};
use wasmi::{Caller, Engine, Func, Linker, Module as WasmiModule, Store};

/// Synthesised module that exports `store_at(addr: i32, value: i32)` and pre-
/// imports `(cetus.watchpoint (func (param i32 i32)))`.
fn store_at_module() -> Vec<u8> {
    let mut module = Module::new();

    let mut types = TypeSection::new();
    types.ty().function([ValType::I32, ValType::I32], []);
    module.section(&types);

    let mut imports = ImportSection::new();
    imports.import("cetus", "watchpoint", EntityType::Function(0));
    module.section(&imports);

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
    exports.export("store_at", ExportKind::Func, 1);
    module.section(&exports);

    let mut code = CodeSection::new();
    let mut func = Function::new(vec![]);
    func.instruction(&Instruction::LocalGet(0));
    func.instruction(&Instruction::LocalGet(1));
    func.instruction(&Instruction::I32Store(MemArg {
        offset: 0,
        align: 2,
        memory_index: 0,
    }));
    func.instruction(&Instruction::End);
    code.function(&func);
    module.section(&code);

    module.finish()
}

/// Synthesised module exporting `noop(x) -> x` and `square(x) -> x*x`.
fn two_func_module() -> Vec<u8> {
    let mut module = Module::new();

    let mut types = TypeSection::new();
    types.ty().function([ValType::I32], [ValType::I32]);
    module.section(&types);

    let mut functions = FunctionSection::new();
    functions.function(0);
    functions.function(0);
    module.section(&functions);

    let mut exports = ExportSection::new();
    exports.export("noop", ExportKind::Func, 0);
    exports.export("square", ExportKind::Func, 1);
    module.section(&exports);

    let mut code = CodeSection::new();

    let mut noop = Function::new(vec![]);
    noop.instruction(&Instruction::LocalGet(0));
    noop.instruction(&Instruction::End);
    code.function(&noop);

    let mut square = Function::new(vec![]);
    square.instruction(&Instruction::LocalGet(0));
    square.instruction(&Instruction::LocalGet(0));
    square.instruction(&Instruction::I32Mul);
    square.instruction(&Instruction::End);
    code.function(&square);

    module.section(&code);

    module.finish()
}

#[test]
fn watchpoint_insertion_emits_validated_module_and_fires_callback() {
    let original = store_at_module();
    wasmparser::validate(&original).expect("fixture is a valid wasm module");

    let instrumented = instrument_watchpoint(&original, 0x80, FLAG_WRITE)
        .expect("instrument_watchpoint succeeds");
    wasmparser::validate(&instrumented).expect("instrumented module passes validation");

    let engine = Engine::default();
    let module = WasmiModule::new(&engine, &instrumented).expect("module compiles");
    let mut store = Store::new(&engine, 0u32);

    let watchpoint = Func::wrap(
        &mut store,
        |mut caller: Caller<'_, u32>, addr: i32, flags: i32| {
            assert_eq!(addr, 0x80, "callback should receive target address");
            assert_eq!(flags & FLAG_WRITE as i32, FLAG_WRITE as i32);
            *caller.data_mut() += 1;
        },
    );

    let mut linker = Linker::new(&engine);
    linker
        .define("cetus", "watchpoint", watchpoint)
        .expect("define watchpoint import");
    let instance = linker
        .instantiate(&mut store, &module)
        .expect("instantiate")
        .start(&mut store)
        .expect("start");
    let store_at = instance
        .get_typed_func::<(i32, i32), ()>(&store, "store_at")
        .expect("export store_at");

    store_at
        .call(&mut store, (0x80, 42))
        .expect("call store_at(0x80, 42)");

    assert!(
        *store.data() >= 1,
        "watchpoint callback should fire at least once for target address"
    );
}

#[test]
fn apply_patch_valid_body_validates_and_changes_behavior() {
    let original = two_func_module();
    wasmparser::validate(&original).expect("fixture is valid");

    // Replace square(x) -> x*x with the body of doubling: x + x.
    let double_body: Vec<u8> = vec![
        0x00, // 0 local decls
        0x20, 0x00, // local.get 0
        0x20, 0x00, // local.get 0
        0x6A, // i32.add
        0x0B, // end
    ];

    let patched = apply_patch(&original, 1, &double_body).expect("patch applies");
    wasmparser::validate(&patched).expect("patched module is valid");

    let engine = Engine::default();
    let module = WasmiModule::new(&engine, &patched).expect("compiles");
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

    assert_eq!(square.call(&mut store, 5).expect("call square"), 10);
}

#[test]
fn apply_patch_rejects_invalid_body_and_does_not_emit_module() {
    let original = two_func_module();

    // 0xFF is not a valid WASM opcode in the core spec.
    let invalid_body: Vec<u8> = vec![0x00, 0xFF, 0x0B];

    let err = apply_patch(&original, 1, &invalid_body)
        .expect_err("invalid patch body must return Err");
    match err {
        WailError::InvalidPatchBody(_) => {}
        other => panic!("expected InvalidPatchBody, got: {other:?}"),
    }
}
