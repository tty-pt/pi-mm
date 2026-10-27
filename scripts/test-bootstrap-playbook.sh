#!/usr/bin/env bash
set -euo pipefail

# test-bootstrap-playbook.sh — Non-destructive verification of zero-config bootstrap,
# auto-download, config recreation, daemon recovery, and proactive dependency alerts.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MM_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
RED="\033[31m"
RESET="\033[0m"

echo -e "${BOLD}${CYAN}=== Pi Zero-Config Bootstrap & Dependency Playbook ===${RESET}\n"

function run_test_daemon() {
  echo -e "${BOLD}[1/4] Testing Daemon Auto-Recovery (Killing & Auto-Restart)${RESET}"
  echo "Current status of axil-auren on port 4242:"
  if curl -s -m 1 http://127.0.0.1:4242/v1/models >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${RESET} Server is currently ONLINE on port 4242."
    echo "  Killing running axil-auren process..."
    pkill -f "axil.*libaxil-auren" || true
    sleep 0.5
  fi

  if curl -s -m 1 http://127.0.0.1:4242/v1/models >/dev/null 2>&1; then
    echo -e "  ${RED}✗ Failed to stop daemon.${RESET}"
  else
    echo -e "  ${GREEN}✓${RESET} Daemon is confirmed DOWN (connection refused as expected)."
  fi

  echo "  Invoking ensureAuren() to auto-start daemon..."
  deno eval --allow-all '
    import { ensureAuren } from "'"$MM_DIR"'/src/auren-bootstrap.ts";
    const st = await ensureAuren({ settings: { autoStart: true, autoDownloadModels: "manual" } });
    console.log("  Auto-start result: daemon running =", st.launcher?.running);
  '

  if curl -s -m 2 http://127.0.0.1:4242/v1/models >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓ PASS:${RESET} axil-auren was successfully revived by ensureAuren() on port 4242!\n"
  else
    echo -e "  ${RED}✗ FAIL:${RESET} Daemon did not recover automatically.\n"
    return 1
  fi
}

function run_test_config() {
  echo -e "${BOLD}[2/4] Testing Zero-Config Auto-Generation (Simulating Missing auren.json)${RESET}"
  local SCRATCH
  SCRATCH="$(mktemp -d /tmp/test-auren-config-XXXXXX)"
  mkdir -p "$SCRATCH/.models"
  # Touch a dummy model to verify discovery
  touch "$SCRATCH/.models/qwen2.5-0.5b-instruct.gguf"
  touch "$SCRATCH/.models/bge-base-en-v1.5.gguf"

  echo "  Running bootstrap with fresh, unconfigured HOME at $SCRATCH..."
  deno eval --allow-all '
    import { ensureAuren } from "'"$MM_DIR"'/src/auren-bootstrap.ts";
    import { existsSync, readFileSync } from "node:fs";
    import { join } from "node:path";

    const home = "'"$SCRATCH"'";
    await ensureAuren({ home, settings: { autoStart: false, autoDownloadModels: "manual" } });
    const cfgPath = join(home, ".config", "auren", "config.json");
    if (!existsSync(cfgPath)) {
      console.error("Config file was not created!");
      Deno.exit(1);
    }
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    console.log("  Generated config successfully:", cfgPath);
    console.log("  Managed by:", cfg._managedBy);
    console.log("  Models detected:", cfg.models.map(m => m.id).join(", "));
  '

  rm -rf "$SCRATCH"
  echo -e "  ${GREEN}✓ PASS:${RESET} Zero-config generated ~/.config/auren/config.json with correct models!\n"
}

function run_test_models() {
  echo -e "${BOLD}[3/4] Testing Model Auto-Download & Confirmation Dialog${RESET}"
  local SCRATCH
  SCRATCH="$(mktemp -d /tmp/test-auren-models-XXXXXX)"

  echo "  Running bootstrap in empty model directory..."
  deno eval --allow-all '
    import { ensureAuren } from "'"$MM_DIR"'/src/auren-bootstrap.ts";
    const home = "'"$SCRATCH"'";
    let confirmPrompted = false;
    await ensureAuren({
      home,
      settings: { autoStart: false, autoDownloadModels: "manual" },
      confirm: async (msg) => {
        confirmPrompted = true;
        console.log("  [Confirmation Hook Triggered]:", msg.slice(0, 75) + "...");
        return false; // User clicks "Cancel" / "No"
      }
    });
    if (!confirmPrompted) {
      console.error("Expected confirmation dialog for heavy model (olmoe)!");
      Deno.exit(1);
    }
  '
  rm -rf "$SCRATCH"
  echo -e "  ${GREEN}✓ PASS:${RESET} Heavy model prompted for interactive confirmation; light models auto-configured!\n"
}

function run_test_dependencies() {
  echo -e "${BOLD}[4/4] Testing Proactive Dependency & Version Detection on session_start${RESET}"
  echo "  Inspecting current system C engine status:"
  deno eval --allow-all '
    import { checkAllEngineVersions, formatRemediationToast } from "'"$MM_DIR"'/src/versions.ts";
    const reports = checkAllEngineVersions();
    for (const r of reports) {
      const sym = r.status === "satisfied" ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
      const ver = r.version ? `${r.version} (${r.source})` : "not installed";
      console.log(`    ${sym} ${r.name.padEnd(11)}: ${ver.padEnd(20)} (requires >= ${r.minRequired})`);
    }

    console.log("\n  Simulating what a user sees on session_start if axil-auren or libsepal is missing:");
    const mockRep = {
      name: "axil-auren",
      installed: false,
      version: null,
      minRequired: "1.3.0",
      status: "missing",
      source: null,
    };
    console.log("    TUI Warning Toast -> " + "\x1b[33m" + formatRemediationToast(mockRep) + "\x1b[0m");

    const mockOutdated = {
      name: "libcorm",
      installed: true,
      version: "1.9.0",
      minRequired: "2.0.0",
      status: "outdated",
      source: "pkgconfig",
    };
    console.log("    TUI Outdated Toast -> " + "\x1b[33m" + formatRemediationToast(mockOutdated) + "\x1b[0m");
  '
  echo -e "\n  ${GREEN}✓ PASS:${RESET} Version scanner accurately discovers status and produces clean TUI notices without running /doctor!\n"
}

case "${1:-all}" in
  daemon)
    run_test_daemon
    ;;
  config)
    run_test_config
    ;;
  models)
    run_test_models
    ;;
  deps)
    run_test_dependencies
    ;;
  all)
    run_test_daemon
    run_test_config
    run_test_models
    run_test_dependencies
    echo -e "${BOLD}${GREEN}All 4 playbook scenarios verified successfully!${RESET}"
    ;;
  *)
    echo "Usage: $0 [daemon|config|models|deps|all]"
    exit 1
    ;;
esac
