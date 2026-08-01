fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_status",
            "activate_desktop",
            "desktop_login",
            "desktop_logout",
            "lock_desktop",
            "synchronize_desktop",
            "desktop_claim_details",
            "reset_desktop",
        ]),
    ))
    .expect("failed to build ClaimGuard's restricted Tauri command manifest");
}
