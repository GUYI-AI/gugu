#!/bin/sh
set -eu
# Run on macOS with the selected Xcode; no simulator or account is used.
cd "$(dirname "$0")/../.."
TASK_SAVE_TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TASK_SAVE_TEST_DIR"' EXIT HUP INT TERM
xcrun swiftc apps/mobile/ios/FileSave/GuguSaveFileStore.swift apps/mobile/ios/FileSaveTests/main.swift -o "$TASK_SAVE_TEST_DIR/file-save-tests"
"$TASK_SAVE_TEST_DIR/file-save-tests"
