//! `make build`: the deployable wasm at `contract/res/chair_token.wasm`, from the same pipeline the tests use.

use cargo_near_build::camino::Utf8PathBuf;

fn main() -> anyhow::Result<()> {
    let out_dir = Utf8PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../contract/res"));
    let wasm = sandbox_tests::build_contract(Some(out_dir))?;
    println!("built {wasm}");
    Ok(())
}
