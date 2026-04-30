import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const addonRoot = path.join(root, "addons", "resonant-browser-native");
const cefRoot = path.join(
  addonRoot,
  "vendor",
  "cef",
  "cef_binary_147.0.10+gd58e84d+chromium-147.0.7727.118_macosarm64",
);
const nativeHostSource = path.join(addonRoot, "native_host");
const buildDir = path.join(addonRoot, "build");
const bridgeDylib = path.join(buildDir, "libResonantBrowserNativeBridgeShared.dylib");
const hostApp = path.join(buildDir, "ResonantBrowserNativeHost.app");
const stagedResourceDir = path.join(root, "build", "native-browser");
const stagedBridgeDylib = path.join(stagedResourceDir, "libResonantBrowserNativeBridgeShared.dylib");
const stagedHostZip = path.join(stagedResourceDir, "ResonantBrowserNativeHost.app.zip");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(cefRoot)) {
  console.error(`CEF binary distribution missing: ${cefRoot}`);
  console.error("Run: node addons/resonant-browser-native/scripts/fetch-cef.mjs --download");
  process.exit(1);
}

run("cmake", ["-S", nativeHostSource, "-B", buildDir, `-DCEF_ROOT=${cefRoot}`]);
run("cmake", [
  "--build",
  buildDir,
  "--target",
  "ResonantBrowserNativeBridgeShared",
  "ResonantBrowserNativeBridge",
  "ResonantBrowserNativeHost",
  "-j",
  "4",
]);

if (!existsSync(bridgeDylib) || !existsSync(hostApp)) {
  console.error("Native Browser build completed but required artifacts are missing.");
  process.exit(1);
}

mkdirSync(stagedResourceDir, { recursive: true });
copyFileSync(bridgeDylib, stagedBridgeDylib);
rmSync(stagedHostZip, { force: true });

// Intent citation: docs/architecture/ADR-025-native-embedded-browser-host.md
// The Chromium .framework bundle must stay structurally intact; Tauri resource
// recursion rewrites framework internals, so packaged builds carry the host as a
// zip and Rust unpacks it before initializing CEF.
run("/usr/bin/ditto", [
  "-c",
  "-k",
  "--sequesterRsrc",
  "--keepParent",
  hostApp,
  stagedHostZip,
]);

if (!existsSync(stagedBridgeDylib) || !existsSync(stagedHostZip)) {
  console.error("Native Browser staging failed; packaged resources are missing.");
  process.exit(1);
}

console.log(`Native Browser assets staged for Tauri packaging: ${stagedResourceDir}`);
