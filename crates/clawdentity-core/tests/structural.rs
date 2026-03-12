use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const MAX_LINES_PER_FILE: usize = 800;
const MAX_FUNCTION_LINES: usize = 50;

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
        if is_test_file(&file) {
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

#[test]
fn no_commented_out_code_blocks() {
    let workspace_root = workspace_root();
    let files = source_files(&workspace_root).expect("failed to collect Rust source files");

    let mut violations = Vec::new();
    for file in files {
        let content = fs::read_to_string(&file).expect("failed to read source file");
        violations.extend(find_commented_out_code_blocks(
            &workspace_root,
            &file,
            &content,
        ));
    }

    assert!(
        violations.is_empty(),
        "Structural rule failed: commented-out code blocks are not allowed in Rust source.\n{}\nRemediation: delete dead code and use git history when recovery is needed.",
        violations.join("\n")
    );
}

#[test]
fn no_non_test_function_exceeds_50_lines() {
    let workspace_root = workspace_root();
    let files = source_files(&workspace_root).expect("failed to collect Rust source files");

    let mut violations = Vec::new();
    for file in files {
        if is_test_file(&file) {
            continue;
        }

        let content = fs::read_to_string(&file).expect("failed to read source file");
        for function in collect_functions(&content) {
            if function.is_test || function.allow_long_function {
                continue;
            }

            let length = function.end_line.saturating_sub(function.start_line) + 1;
            if length > MAX_FUNCTION_LINES {
                violations.push(format!(
                    "FUNCTION_TOO_LONG: {}:{} function '{}' is {} lines (limit: {}).",
                    display_path(&workspace_root, &file),
                    function.start_line,
                    function.name,
                    length,
                    MAX_FUNCTION_LINES
                ));
            }
        }
    }

    assert!(
        violations.is_empty(),
        "Structural rule failed: non-test functions exceed {} lines.\n{}\nRemediation: split long functions into smaller helpers, or add `#[allow(clippy::too_many_lines)]` above intentionally large functions with reviewer justification.",
        MAX_FUNCTION_LINES,
        violations.join("\n")
    );
}

#[test]
fn public_functions_must_be_documented() {
    let workspace_root = workspace_root();
    let files = source_files(&workspace_root).expect("failed to collect Rust source files");

    let mut violations = Vec::new();
    for file in files {
        if is_test_file(&file) {
            continue;
        }

        let content = fs::read_to_string(&file).expect("failed to read source file");
        for function in collect_functions(&content) {
            if function.is_test || !function.is_public || function.has_doc_comment {
                continue;
            }

            violations.push(format!(
                "UNDOCUMENTED: {}:{} public function '{}' lacks doc comment.",
                display_path(&workspace_root, &file),
                function.start_line,
                function.name
            ));
        }
    }

    assert!(
        violations.is_empty(),
        "Structural rule failed: public Rust functions must include doc comments.\n{}\nRemediation: add `///` comments that describe contract, inputs, and side effects for each public function.",
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

fn is_test_file(path: &Path) -> bool {
    if path
        .components()
        .any(|part| part.as_os_str().to_string_lossy() == "tests")
    {
        return true;
    }

    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| name.ends_with("_tests.rs") || name.ends_with("_test.rs"))
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

fn find_commented_out_code_blocks(
    workspace_root: &Path,
    path: &Path,
    content: &str,
) -> Vec<String> {
    let mut violations = Vec::new();
    let mut block_start_line: Option<usize> = None;
    let mut block_lines: Vec<String> = Vec::new();

    let flush_block = |block_start_line: &mut Option<usize>,
                       block_lines: &mut Vec<String>,
                       violations: &mut Vec<String>| {
        if let Some(start_line) = *block_start_line
            && block_lines.len() >= 3
            && block_lines
                .iter()
                .any(|line| is_code_like_comment_line(line))
        {
            violations.push(format!(
                "DEAD_CODE: {}:{} has commented-out code block. Delete it - git has history.",
                display_path(workspace_root, path),
                start_line
            ));
        }

        *block_start_line = None;
        block_lines.clear();
    };

    for (index, line) in content.lines().enumerate() {
        let trimmed = line.trim_start();
        let is_line_comment =
            trimmed.starts_with("//") && !trimmed.starts_with("///") && !trimmed.starts_with("//!");

        if is_line_comment {
            if block_start_line.is_none() {
                block_start_line = Some(index + 1);
            }
            block_lines.push(trimmed.trim_start_matches("//").trim().to_string());
            continue;
        }

        flush_block(&mut block_start_line, &mut block_lines, &mut violations);
    }

    flush_block(&mut block_start_line, &mut block_lines, &mut violations);
    violations
}

fn is_code_like_comment_line(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.contains("fn ")
        || trimmed.contains("const ")
        || trimmed.contains("let ")
        || trimmed.contains("import ")
        || trimmed.contains("use ")
        || trimmed.contains("return ")
        || trimmed.contains("if ")
        || trimmed.contains("if(")
        || trimmed.contains("for ")
        || trimmed.contains("for(")
}

#[derive(Debug)]
struct FunctionInfo {
    name: String,
    start_line: usize,
    end_line: usize,
    is_public: bool,
    is_test: bool,
    has_doc_comment: bool,
    allow_long_function: bool,
}

fn collect_functions(content: &str) -> Vec<FunctionInfo> {
    let lines: Vec<&str> = content.lines().collect();
    let mut functions = Vec::new();
    let mut pending_test_cfg = false;
    let mut skip_test_depth = 0_i32;

    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();

        if skip_test_depth > 0 {
            skip_test_depth += brace_delta(line);
            if skip_test_depth <= 0 {
                skip_test_depth = 0;
            }
            continue;
        }

        if pending_test_cfg {
            let delta = brace_delta(line);
            if delta > 0 {
                skip_test_depth = delta;
            }
            pending_test_cfg = false;
            continue;
        }

        if trimmed.contains("cfg(test)") {
            pending_test_cfg = true;
            continue;
        }

        let Some(name) = parse_function_name(trimmed) else {
            continue;
        };

        let Some(end_line) = find_function_end(&lines, index) else {
            continue;
        };

        let is_public = is_public_signature(trimmed);
        let is_test =
            name.starts_with("test_") || has_attribute(&lines, index, |attr| attr.contains("test"));
        let has_doc_comment = has_doc_comment(&lines, index);
        let allow_long_function = has_attribute(&lines, index, |attr| {
            attr.contains("allow") && attr.contains("clippy::too_many_lines")
        });

        functions.push(FunctionInfo {
            name,
            start_line: index + 1,
            end_line,
            is_public,
            is_test,
            has_doc_comment,
            allow_long_function,
        });
    }

    functions
}

fn parse_function_name(trimmed: &str) -> Option<String> {
    if trimmed.starts_with("//") || trimmed.starts_with("/*") || trimmed.starts_with('*') {
        return None;
    }

    let tokens: Vec<&str> = trimmed.split_whitespace().collect();
    let fn_index = tokens.iter().position(|token| *token == "fn")?;
    let name_token = tokens.get(fn_index + 1)?;

    let name: String = name_token
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
        .collect();

    if name.is_empty() {
        return None;
    }

    Some(name)
}

fn is_public_signature(trimmed: &str) -> bool {
    let mut tokens = trimmed.split_whitespace();
    if tokens.next() != Some("pub") {
        return false;
    }

    tokens.any(|token| token == "fn")
}

fn has_doc_comment(lines: &[&str], function_start_index: usize) -> bool {
    let mut cursor = function_start_index as i32 - 1;
    let mut saw_doc_comment = false;

    while cursor >= 0 {
        let trimmed = lines[cursor as usize].trim();

        if trimmed.is_empty() {
            if saw_doc_comment {
                return true;
            }
            cursor -= 1;
            continue;
        }

        if trimmed.starts_with("///") || trimmed.starts_with("#[doc =") {
            saw_doc_comment = true;
            cursor -= 1;
            continue;
        }

        if trimmed.starts_with("#") {
            cursor -= 1;
            continue;
        }

        break;
    }

    saw_doc_comment
}

fn has_attribute<F>(lines: &[&str], function_start_index: usize, mut predicate: F) -> bool
where
    F: FnMut(&str) -> bool,
{
    let mut cursor = function_start_index as i32 - 1;

    while cursor >= 0 {
        let trimmed = lines[cursor as usize].trim();
        if trimmed.is_empty() || trimmed.starts_with("///") {
            cursor -= 1;
            continue;
        }

        if trimmed.starts_with("#") {
            if predicate(trimmed) {
                return true;
            }
            cursor -= 1;
            continue;
        }

        break;
    }

    false
}

fn find_function_end(lines: &[&str], start_index: usize) -> Option<usize> {
    let mut body_started = false;
    let mut body_depth = 0_i32;

    for (index, line) in lines.iter().enumerate().skip(start_index) {
        let trimmed = line.trim();
        if trimmed.starts_with("//") {
            continue;
        }

        let code = strip_inline_comment(line);
        if !body_started {
            if code.contains('{') {
                body_started = true;
            } else if trimmed.ends_with(';') {
                return None;
            } else {
                continue;
            }
        }

        body_depth += brace_delta(code);
        if body_started && body_depth <= 0 {
            return Some(index + 1);
        }
    }

    None
}

fn strip_inline_comment(line: &str) -> &str {
    line.split("//").next().unwrap_or(line)
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
