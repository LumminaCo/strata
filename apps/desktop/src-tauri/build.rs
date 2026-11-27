use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    let target = env::var("TARGET").expect("Cargo target");
    let host = env::var("HOST").expect("Cargo host");
    let profile = env::var("PROFILE").expect("Cargo profile");
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
    let workspace_root = manifest.join("../../..");
    let module = workspace_root.join("bridge/oracle");
    let binaries = manifest.join("bin");
    fs::create_dir_all(&binaries).expect("create sidecar directory");
    let extension = if os == "windows" { ".exe" } else { "" };

    let bridge_binary = binaries.join(format!("oracle-bridge-{target}{extension}"));
    println!("cargo:rerun-if-changed={}", module.display());
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-env-changed=STRATA_CLI_BIN");
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
        .arg(bridge_binary)
        .arg(".")
        .status()
        .expect("run the Go compiler for the Oracle sidecar");
    assert!(status.success(), "The Oracle sidecar build failed");

    let cli_binary = binaries.join(format!("strata-{target}{extension}"));
    if let Some(staged) = env::var_os("STRATA_CLI_BIN").filter(|value| !value.is_empty()) {
        let staged = PathBuf::from(staged);
        println!("cargo:rerun-if-changed={}", staged.display());
        fs::copy(&staged, &cli_binary).unwrap_or_else(|error| {
            panic!(
                "copy staged Strata CLI from {} to {}: {error}",
                staged.display(),
                cli_binary.display()
            )
        });
    } else if !cli_binary.is_file() {
        assert!(
            host == target,
            "Cross-compiling strata-desktop requires pre-staging {} (run `just cli` or set STRATA_CLI_BIN)",
            cli_binary.display()
        );
        let cargo = env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
        let sidecar_target = workspace_root.join("target/sidecar-cli");
        let mut command = Command::new(cargo);
        command
            .current_dir(&workspace_root)
            .args(["build", "--locked", "-p", "strata-cli", "--target-dir"])
            .arg(&sidecar_target);
        if profile == "release" {
            command.arg("--release");
        }
        let status = command
            .status()
            .expect("build the Strata CLI sidecar binary");
        assert!(status.success(), "The Strata CLI sidecar build failed");
        let built = sidecar_target
            .join(&profile)
            .join(format!("strata{extension}"));
        fs::copy(&built, &cli_binary).unwrap_or_else(|error| {
            panic!(
                "copy built Strata CLI from {} to {}: {error}",
                built.display(),
                cli_binary.display()
            )
        });
    }

    tauri_build::build();
}
