use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    let target = env::var("TARGET").expect("Cargo target");
    let os = env::var("CARGO_CFG_TARGET_OS").expect("Cargo target OS");
    let arch = env::var("CARGO_CFG_TARGET_ARCH").expect("Cargo target architecture");
    let go_os = if os == "macos" { "darwin" } else { os.as_str() };
    let go_arch = match arch.as_str() {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        _ => panic!("The Oracle sidecar does not support {arch}"),
    };
    let manifest =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"));
    let module = manifest.join("../../../bridge/oracle");
    let binaries = manifest.join("bin");
    fs::create_dir_all(&binaries).expect("create sidecar directory");
    let extension = if os == "windows" { ".exe" } else { "" };
    let binary = binaries.join(format!("oracle-bridge-{target}{extension}"));
    println!("cargo:rerun-if-changed={}", module.display());
    println!("cargo:rerun-if-changed=tauri.conf.json");
    let status = Command::new("go")
        .current_dir(module)
        .env("CGO_ENABLED", "0")
        .env("GOOS", go_os)
        .env("GOARCH", go_arch)
        .args([
            "build",
            "-mod=readonly",
            "-trimpath",
            "-ldflags=-s -w",
            "-o",
        ])
        .arg(binary)
        .arg(".")
        .status()
        .expect("run the Go compiler for the Oracle sidecar");
    assert!(status.success(), "The Oracle sidecar build failed");
    tauri_build::build();
}
