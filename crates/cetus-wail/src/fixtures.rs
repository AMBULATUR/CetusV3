//! Synthesised WebAssembly module fixtures for unit tests.
//!
//! Per `design.md` §Decisions "Scope narrowing discovered during Stage 4 → 5
//! transition", the Rust crate's tests use hand-built modules instead of
//! comparing against v1.05 `wail.min.js` reference output.

#![cfg(test)]
#![allow(dead_code)]

use wasm_encoder::{
    CodeSection, EntityType, ExportKind, ExportSection, Function, FunctionSection, ImportSection,
    Instruction, MemArg, MemorySection, MemoryType, Module, TypeSection, ValType,
};

/// Build a minimal valid module that exports `store_at(addr: i32, value: i32)`
/// performing `i32.store` at the given dynamic address. The module pre-imports
/// `(cetus.watchpoint (func (param i32 i32)))` at function index 0 so
/// `instrument_watchpoint` has somewhere to wire the callback to.
pub(crate) fn store_at_module() -> Vec<u8> {
    let mut module = Module::new();

    let mut types = TypeSection::new();
    // type 0: (param i32 i32) -> ()  - shared by watchpoint import and store_at
    types
        .ty()
        .function([ValType::I32, ValType::I32], []);
    module.section(&types);

    let mut imports = ImportSection::new();
    imports.import("cetus", "watchpoint", EntityType::Function(0));
    module.section(&imports);

    let mut functions = FunctionSection::new();
    functions.function(0); // local function 0 (overall index 1, after import)
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
    // export the local function (index 1, after the imported watchpoint)
    exports.export("store_at", ExportKind::Func, 1);
    exports.export("mem", ExportKind::Memory, 0);
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

/// Build a minimal valid module with two functions used to validate
/// `apply_patch`. `noop(x)` returns x; `square(x)` returns x*x. Both are
/// exported.
pub(crate) fn two_func_module() -> Vec<u8> {
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

/// Build a minimal module that exports a single function returning `42`.
/// Used by `list_function_bodies` tests to verify the returned byte slice
/// matches the encoded body.
pub(crate) fn const_module() -> Vec<u8> {
    let mut module = Module::new();

    let mut types = TypeSection::new();
    types.ty().function([], [ValType::I32]);
    module.section(&types);

    let mut functions = FunctionSection::new();
    functions.function(0);
    module.section(&functions);

    let mut exports = ExportSection::new();
    exports.export("answer", ExportKind::Func, 0);
    module.section(&exports);

    let mut code = CodeSection::new();
    let mut func = Function::new(vec![]);
    func.instruction(&Instruction::I32Const(42));
    func.instruction(&Instruction::End);
    code.function(&func);
    module.section(&code);

    module.finish()
}
