fn main() {
    if let Some((_, wasm_path)) = sails_rs::build_wasm() {
        sails_rs::ClientBuilder::<::digger_world_app::Program>::from_wasm_path(
            wasm_path.with_extension(""),
        )
        .with_program_name("digger_world")
        .build_idl();
    }
}
