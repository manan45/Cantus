# Shipping Cantus — macOS Apple Silicon

## Prerequisites

- Xcode Command Line Tools (`xcode-select --install`)
- Active Apple Developer Program membership
- `cargo` + Rust toolchain (`rustup target add aarch64-apple-darwin`)
- Node.js ≥ 22 (for the frontend build step only — the bundled sidecar ships its own)

## 1. Populate the Node sidecar and agent-host dependencies

This step runs once (or when upgrading Node). It downloads the official macOS ARM
Node.js binary into `src-tauri/binaries/` and runs `npm ci` in `agent-host/`.

```sh
./scripts/bundle-node.sh        # uses Node 22 by default; pass a version arg to override
```

## 2. Export Apple signing credentials

Tauri reads these from the environment — never hard-code them in `tauri.conf.json`.

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="your@apple.id"
export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # app-specific password from appleid.apple.com
export APPLE_TEAM_ID="TEAMID"
```

Set `signingIdentity` and `providerShortName` in `src-tauri/tauri.conf.json` to the
same values, or keep them `null` and rely entirely on the environment variables above
(Tauri reads `APPLE_SIGNING_IDENTITY` automatically).

## 3. Build, sign, and notarize

```sh
cargo tauri build --target aarch64-apple-darwin
```

Tauri runs code-signing and notarization automatically when the four environment
variables above are set. The finished `.dmg` is in:

```
src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Cantus_*.dmg
```

## 4. Staple the notarization ticket

After notarization completes (Tauri waits for it), staple the ticket so Gatekeeper
can verify the app offline:

```sh
xcrun stapler staple \
  src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Cantus_*.dmg
```

Verify:

```sh
xcrun stapler validate \
  src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Cantus_*.dmg
spctl --assess --type open --context context:primary-signature -v \
  src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Cantus.app
```

## Bundle anatomy

What ships inside `Cantus.app/Contents/`:

| Path | Contents |
|---|---|
| `MacOS/Cantus` | Rust binary |
| `MacOS/node` | Bundled Node.js ARM sidecar (V8 JIT enabled via entitlements) |
| `Resources/agent-host/index.mjs` | Agent host script |
| `Resources/agent-host/node_modules/` | `@anthropic-ai/claude-agent-sdk` and deps |

The bundled Node binary + agent-host mean users need zero external tools — no
Homebrew, no `npm install`, no version pinning.
