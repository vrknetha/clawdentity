use std::fs;
use std::path::{Path, PathBuf};

use tempfile::TempDir;

use super::{OPENCLAW_CONFIG_FILE_NAME, resolve_openclaw_dir};

const MOCK_OPENCLAW_SCRIPT: &str = r#"#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const configPath = process.env.OPENCLAW_CONFIG_PATH;

if (!configPath) {
  console.error("OPENCLAW_CONFIG_PATH is required");
  process.exit(1);
}

function readConfig() {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  const raw = fs.readFileSync(configPath, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function writeConfig(value) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`);
}

function setPath(target, dottedPath, value) {
  const parts = dottedPath.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

function getPath(target, dottedPath) {
  return dottedPath.split(".").reduce((cursor, part) => {
    if (cursor === undefined || cursor === null) {
      return undefined;
    }
    return cursor[part];
  }, target);
}

if (args[0] === "config" && args[1] === "set") {
  const config = readConfig();
  setPath(config, args[2], JSON.parse(args[3]));
  writeConfig(config);
  process.exit(0);
}

if (args[0] === "config" && args[1] === "get") {
  const value = getPath(readConfig(), args[2]);
  if (value === undefined) {
    console.error("Config path not found");
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(0);
}

console.error(`unsupported mock openclaw command: ${args.join(" ")}`);
process.exit(1);
"#;

fn write_mock_openclaw_script(script_path: &Path) {
    fs::write(script_path, MOCK_OPENCLAW_SCRIPT).expect("mock openclaw script");
}

#[cfg(unix)]
fn make_script_executable(script_path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(script_path).expect("metadata").permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(script_path, permissions).expect("chmod");
}

#[cfg(not(unix))]
fn make_script_executable(_: &Path) {}

pub(crate) fn install_mock_openclaw_cli() -> TempDir {
    let bin_dir = TempDir::new().expect("temp bin");
    let script_path = bin_dir.path().join("openclaw");
    write_mock_openclaw_script(&script_path);
    make_script_executable(&script_path);
    bin_dir
}

pub(crate) fn write_openclaw_profile(home_dir: &Path, config_body: &str) -> PathBuf {
    let openclaw_dir = resolve_openclaw_dir(Some(home_dir), None).expect("openclaw dir");
    fs::create_dir_all(&openclaw_dir).expect("openclaw dir");
    let config_path = openclaw_dir.join(OPENCLAW_CONFIG_FILE_NAME);
    fs::write(&config_path, config_body).expect("openclaw config");
    config_path
}
