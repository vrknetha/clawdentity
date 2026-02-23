use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const MAX_LINES_PER_FILE: usize = 800;

#[test]
fn no_file_exceeds_800_lines() {
    let workspace_root = workspace_root();
    let files = source_files(&workspace_root).expect("failed to collect Rust source files");

    let mut violations = Vec::new();
    for file in files {
        let content = fs::read_to_string(&file).expect("failed to read source file");
        let line_count = content.lines().count();
        if line_count > MAX_LINES_PER_FILE {
            violations.push(format!(
                "{} has {} lines (limit: {})",
                display_path(&workspace_root, &file),
                line_count,
                MAX_LINES_PER_FILE
            ));
        }
    }

    assert!(
        violations.is_empty(),
        "Structural rule failed: one or more Rust files exceed {} lines.\n{}\nRemediation: split oversized files into focused modules so each file stays at or below {} lines.",
        MAX_LINES_PER_FILE,
        violations.join("\n"),
        MAX_LINES_PER_FILE
    );
}

#[test]
fn no_unwrap_outside_tests() {
    let workspace_root = workspace_root();
    let files = source_files(&workspace_root).expect("failed to collect Rust source files");

    let mut violations = Vec::new();
    for file in files {
        if file.components().any(|part| part.as_os_str() == "tests") {
            continue;
        }

        let content = fs::read_to_string(&file).expect("failed to read source file");
        violations.extend(find_non_test_unwraps(&workspace_root, &file, &content));
    }

    assert!(
        violations.is_empty(),
        "Structural rule failed: `.unwrap()` is not allowed in non-test code.\n{}\nRemediation: replace `.unwrap()` with explicit error handling (`?`, `ok_or_else`, or contextual `CoreError`/`anyhow` propagation).",
        violations.join("\n")
    );
}

#[test]
fn dependency_direction_enforced() {
    let workspace_root = workspace_root();
    let core_src = workspace_root.join("clawdentity-core").join("src");
    let provider_files = rust_files_under(&core_src.join("providers"))
        .expect("failed to collect provider source files");
    let connector_files = rust_files_under(&core_src.join("connector"))
        .expect("failed to collect connector source files");

    let mut violations = Vec::new();
    for file in provider_files {
        let content = fs::read_to_string(&file).expect("failed to read provider source file");
        for (line_number, statement) in relevant_statements(&content) {
            if statement.contains("crate::runtime")
                || statement.contains("crate::runtime_")
                || statement.contains("super::runtime")
            {
                violations.push(format!(
                    "{}:{} imports runtime from providers: `{statement}`",
                    display_path(&workspace_root, &file),
                    line_number
                ));
            }
        }
    }
    for file in connector_files {
        let content = fs::read_to_string(&file).expect("failed to read connector source file");
        for (line_number, statement) in relevant_statements(&content) {
            if statement.contains("crate::providers")
                || statement.contains("crate::provider_")
                || statement.contains("super::providers")
            {
                violations.push(format!(
                    "{}:{} imports providers from connector: `{statement}`",
                    display_path(&workspace_root, &file),
                    line_number
                ));
            }
        }
    }

    assert!(
        violations.is_empty(),
        "Structural rule failed: dependency direction is inverted.\n{}\nRemediation: keep dependency flow one-way by moving shared logic to lower layers (`db`, `connector`, or neutral helpers) and remove direct `providers -> runtime` and `connector -> providers` imports.",
        violations.join("\n")
    );
}

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace root")
        .to_path_buf()
}

fn source_files(workspace_root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    files.extend(rust_files_under(
        &workspace_root.join("clawdentity-core").join("src"),
    )?);
    files.extend(rust_files_under(
        &workspace_root.join("clawdentity-cli").join("src"),
    )?);
    files.sort();
    Ok(files)
}

fn rust_files_under(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    if !root.exists() {
        return Ok(files);
    }
    collect_rust_files(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_rust_files(root: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_rust_files(&path, files)?;
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) == Some("rs") {
            files.push(path);
        }
    }
    Ok(())
}

fn display_path(workspace_root: &Path, path: &Path) -> String {
    path.strip_prefix(workspace_root)
        .unwrap_or(path)
        .display()
        .to_string()
}

fn find_non_test_unwraps(workspace_root: &Path, path: &Path, content: &str) -> Vec<String> {
    let mut violations = Vec::new();
    let mut pending_test_cfg = false;
    let mut skip_depth = 0_i32;

    for (index, line) in content.lines().enumerate() {
        let line_number = index + 1;
        let trimmed = line.trim();

        if skip_depth > 0 {
            skip_depth += brace_delta(line);
            if skip_depth <= 0 {
                skip_depth = 0;
            }
            continue;
        }

        if pending_test_cfg {
            let delta = brace_delta(line);
            if delta > 0 {
                skip_depth = delta;
            }
            pending_test_cfg = false;
            continue;
        }

        if trimmed.contains("cfg(test)") {
            pending_test_cfg = true;
            continue;
        }

        if trimmed.starts_with("//") || trimmed.starts_with("/*") || trimmed.starts_with('*') {
            continue;
        }

        if trimmed.contains(".unwrap()") {
            violations.push(format!(
                "{}:{} contains `.unwrap()`",
                display_path(workspace_root, path),
                line_number
            ));
        }
    }

    violations
}

fn brace_delta(line: &str) -> i32 {
    let open = line.chars().filter(|ch| *ch == '{').count() as i32;
    let close = line.chars().filter(|ch| *ch == '}').count() as i32;
    open - close
}

fn relevant_statements(content: &str) -> Vec<(usize, String)> {
    let mut statements = Vec::new();
    let mut current: Option<(usize, String)> = None;

    for (index, line) in content.lines().enumerate() {
        let line_number = index + 1;
        let trimmed = line.trim();

        if trimmed.starts_with("use ") || trimmed.starts_with("pub use ") {
            current = Some((line_number, trimmed.to_string()));
            if trimmed.ends_with(';')
                && let Some((start_line, statement)) = current.take()
            {
                statements.push((start_line, statement));
            }
            continue;
        }

        if let Some((start_line, mut statement)) = current.take() {
            statement.push(' ');
            statement.push_str(trimmed);
            if trimmed.ends_with(';') {
                statements.push((start_line, statement));
            } else {
                current = Some((start_line, statement));
            }
            continue;
        }

        if trimmed.starts_with("mod ") || trimmed.starts_with("pub mod ") {
            statements.push((line_number, trimmed.to_string()));
        }
    }

    statements
}
