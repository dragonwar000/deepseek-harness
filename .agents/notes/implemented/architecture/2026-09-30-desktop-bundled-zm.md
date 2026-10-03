# Agent Note: Desktop compiles and carries a fastembed zeromem zm and its model

Status: implemented

## Problem

The knowledge bundle's `memory-zeromem` row needs zeromem's `zm` and, for semantic recall, the bge-small-en-v1.5 model. Desktop users should not install either, and nothing should download unpinned bytes.

## Decision

`prepare:runtime` runs `cargo install --git … --rev <pinned sha> --locked --target <triple>` with default features. [`zeromem-lock.json`](../../../../apps/desktop/scripts/zeromem-lock.json) pins the static onnxruntime archive and model files by URL and SHA-256. ort-sys 2.0.0-rc.9 verifies its download against its `dist.txt` (`build.rs:464-465`), but first uses pkg-config and reuses an unverified extraction in the user cache (`build.rs:463`, `564`). Preparation therefore downloads and verifies the archive and sets `ORT_LIB_LOCATION` and `LIBONNXRUNTIME_NO_PKG_CONFIG=1`. `zm` stays one executable that links only system libraries, signed and notarized as before.

The model ships in `resources/runtime/zeromem/models/` in the Hugging Face cache layout: 134 MB beside a 29-32 MB `zm`. Desktop names it in `DSH_ZEROMEM_MODELS`. The plugin checks the files at load and before each operation, because zeromem downloads a missing file at the latest revision, and fails with `ZeromemEmbedderError` instead of accepting zeromem's silent hash fallback. The row uses `embedder: default`. The packaged smoke recalls a paraphrase.

## Alternatives considered

The hash embedder misses paraphrases. Downloading the model on first use needs network access and makes the first recall slow. Vendoring zeromem would put non-Cordis source in `vendor/`. A cargo workspace under `native/` would add Rust to that npm-release workspace for one executable.

## Consequences

Desktop grows by about 163 MB per target. Each operation loads the model: about 1.3 s cold, 0.1 s warm on Apple silicon. macOS x64 cross-builds from arm64; Windows needs a Windows host with the DirectML SDK libraries and is unverified.
