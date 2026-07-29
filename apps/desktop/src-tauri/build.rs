fn main() {
    println!("cargo:rerun-if-env-changed=INKSHADOW_UPDATE_CHANNEL");
    println!("cargo:rerun-if-env-changed=INKSHADOW_UPDATE_MANIFEST_URL");
    println!("cargo:rerun-if-env-changed=INKSHADOW_UPDATE_KEY_ID");
    println!("cargo:rerun-if-env-changed=INKSHADOW_UPDATE_PUBLIC_KEY_B64URL");
    println!("cargo:rerun-if-env-changed=INKSHADOW_UPDATE_SECONDARY_KEY_ID");
    println!("cargo:rerun-if-env-changed=INKSHADOW_UPDATE_SECONDARY_PUBLIC_KEY_B64URL");
    tauri_build::build();
}
