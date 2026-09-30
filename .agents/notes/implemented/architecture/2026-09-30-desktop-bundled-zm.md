# Agent Note: Desktop compiles and carries a hash-embedder zeromem zm

Status: implemented

## Problem

The knowledge bundle's `memory-zeromem` row needs zeromem's `zm`. Desktop users should not have to install it.

## Decision

Desktop runtime preparation runs `cargo install --git … --rev <pinned sha> --locked --no-default-features --target <triple>` into the target's build directory, checks the executable's Mach-O or PE architecture, and copies `zm` with zeromem's hash-pinned `LICENSE` to `resources/runtime/zeromem/`. [`zeromem-lock.json`](../../../../apps/desktop/scripts/zeromem-lock.json) holds the revision and feeds the third-party notices. The file sits beside `runtime/cli/link-entry`, the Mach-O the same step already compiles, so electron-builder signs it with the hardened runtime and notarization covers it, and signed Windows packaging signs every unsigned PE. The packaged smoke runs the signed `zm`.

Desktop passes `DSH_ZEROMEM_ZM` to the Host when that file exists and no inherited value is set. The plugin's `resolveZm` takes a non-empty `zmPath`, then `DSH_ZEROMEM_ZM`, then `zm` on `PATH`, and the bundle row keeps `zmPath` empty with `embedder: hash`. A build host without cargo fails packaging unless `DSH_DESKTOP_OMIT_ZEROMEM=1`; an enabled row in that build needs `zm` on `PATH`, or its load fails with `ZeromemExecutableError`; development launches warn and continue.

## Alternatives considered

The default fastembed build is 27 MB instead of 4.4 MB, links an onnxruntime archive downloaded during the build outside the lock, and downloads a 130 MB model on first use, so recall would depend on network access after installation. Vendoring zeromem would put non-Cordis source in `vendor/`. A cargo workspace under `native/` would add Rust to that npm-release workspace for one executable. zeromem's releases carry only a Linux Python wheel, no `zm`.

## Consequences

Recall is lexical: the hash embedder matches shared words, not paraphrases. Packaging hosts need Rust and each target's standard library; macOS x64 from an arm64 host needs `rustup target add x86_64-apple-darwin`.
