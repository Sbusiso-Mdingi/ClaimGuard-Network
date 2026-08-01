# Windows Desktop Development and Build

## Prerequisites

- Windows 10/11 x64 or Windows Server 2022 runner;
- Microsoft C++ Build Tools with Desktop development with C++;
- Rust stable MSVC toolchain;
- Node.js 22 and pnpm 9;
- Tauri CLI `2.11.4`;
- no database client is required by the desktop.

The NSIS installer embeds the WebView2 offline installer. This adds roughly 127 MB but avoids an installation-time network dependency. Runtime WebView security patches are still managed by Windows.

## Local Development

Set public compile-time trust values before compiling:

```powershell
$env:CLAIMGUARD_ACTIVATION_ORIGIN = "https://api.local.example"
$env:CLAIMGUARD_ENROLLMENT_VERIFYING_JWK = '{"kty":"OKP","crv":"Ed25519","x":"<base64url-public-key>","kid":"<key-id>"}'
pnpm install --frozen-lockfile
pnpm --filter @claimguard/desktop test
pnpm --filter @claimguard/desktop build
cd apps/desktop/src-tauri
cargo test --all-targets --locked
cargo tauri dev
```

Only localhost may use HTTP. Production builds must use HTTPS. The origin and enrollment public key are compiled in and cannot be edited in the UI.

## Exact Windows Installer Build

Tauri updater artifacts require a signing key even for local builds. Generate a disposable development key (never reuse it for production), put its public key into `plugins.updater.pubkey`, and run:

```powershell
cd apps/desktop/src-tauri
cargo install tauri-cli --version 2.11.4 --locked
cargo tauri signer generate --ci -w "$env:TEMP\claimguard-local-updater.key"
$env:TAURI_SIGNING_PRIVATE_KEY = "$env:TEMP\claimguard-local-updater.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
cargo tauri build --bundles nsis
New-Item -ItemType Directory -Force ..\..\..\artifacts | Out-Null
$installer = Get-ChildItem target\release\bundle\nsis\*-setup.exe
Copy-Item $installer.FullName ..\..\..\artifacts\ClaimGuard-Setup.exe
```

The required normalized artifact is exactly `artifacts/ClaimGuard-Setup.exe`. CI also retains `ClaimGuard-Update.nsis.zip` and its `.sig`.

`desktop-windows.yml` uses a disposable updater key and creates inspection artifacts only. `desktop-signed-build.yml` is an explicit, main-SHA-bound, protected-environment workflow that creates Authenticode and persistent-updater-key artifacts but does not publish or deploy them.

## Verification

```powershell
pnpm --filter @claimguard/desktop test
pnpm --filter @claimguard/desktop build
cd apps/desktop/src-tauri
cargo fmt --all --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --all-targets --locked
Get-AuthenticodeSignature ..\..\..\artifacts\ClaimGuard-Setup.exe
```

For production artifacts, `Get-AuthenticodeSignature` must report `Valid`; the updater `.sig` must be published alongside the exact `.nsis.zip` bytes referenced by the update manifest.
