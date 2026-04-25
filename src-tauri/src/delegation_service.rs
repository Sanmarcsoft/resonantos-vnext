// Intent citation: docs/architecture/ADR-009-rust-service-ipc-boundary.md
// Intent citation: docs/architecture/ADR-015-delegation-fabric-addon-catalog-native-tools.md

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::host_state::app_state_dir;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateTaskWorkspaceRequest {
    pub(crate) packet: Value,
    pub(crate) task_markdown: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskWorkspaceRecord {
    pub(crate) id: String,
    pub(crate) packet_id: String,
    pub(crate) root_path: String,
    pub(crate) packet_path: String,
    pub(crate) task_markdown_path: String,
    pub(crate) artifacts_path: String,
    pub(crate) logs_path: String,
    pub(crate) result_path: String,
    pub(crate) verification_path: String,
}

fn unix_timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format!("unix:{seconds}")
}

fn slugify(value: &str) -> String {
    let mut output = String::new();
    let mut last_dash = false;
    for character in value.chars() {
        let lower = character.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            output.push(lower);
            last_dash = false;
        } else if !last_dash {
            output.push('-');
            last_dash = true;
        }
    }
    let trimmed = output.trim_matches('-');
    if trimmed.is_empty() {
        "task-workspace".to_string()
    } else {
        trimmed.to_string()
    }
}

fn required_packet_string(packet: &Value, key: &str) -> Result<String, String> {
    packet
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| format!("Delegation packet `{key}` is required."))
}

fn ensure_dir(path: &Path, label: &str) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| format!("Failed to create {label}: {error}"))
}

fn write_text(path: &Path, content: &str, label: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|error| format!("Failed to write {label}: {error}"))
}

pub(crate) fn task_workspaces_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app_state_dir(app)?.join("task-workspaces");
    ensure_dir(&root, "task workspace root")?;
    Ok(root)
}

pub(crate) fn create_task_workspace_with_root(
    root: &Path,
    request: CreateTaskWorkspaceRequest,
) -> Result<TaskWorkspaceRecord, String> {
    let packet_id = required_packet_string(&request.packet, "id")?;
    let workspace_id = required_packet_string(&request.packet, "workspaceId")?;
    if request.task_markdown.trim().is_empty() {
        return Err("Rendered TASK.md content cannot be empty.".to_string());
    }

    let workspace_root = root.join(slugify(&workspace_id));
    let artifacts_path = workspace_root.join("artifacts");
    let logs_path = workspace_root.join("logs");
    ensure_dir(&artifacts_path, "task artifacts directory")?;
    ensure_dir(&logs_path, "task logs directory")?;

    let packet_path = workspace_root.join("delegation.packet.json");
    let task_markdown_path = workspace_root.join("TASK.md");
    let result_path = workspace_root.join("result.md");
    let verification_path = workspace_root.join("verification.json");
    let audit_path = logs_path.join("audit.jsonl");

    write_text(
        &packet_path,
        &serde_json::to_string_pretty(&request.packet)
            .map_err(|error| format!("Failed to encode delegation packet: {error}"))?,
        "delegation packet",
    )?;
    write_text(&task_markdown_path, &request.task_markdown, "TASK.md")?;
    write_text(
        &result_path,
        "# Delegation Result\n\nNo result has been returned yet.\n",
        "delegation result placeholder",
    )?;
    write_text(
        &verification_path,
        &serde_json::to_string_pretty(&json!({
            "packetId": &packet_id,
            "status": "pending",
            "checks": []
        }))
        .map_err(|error| format!("Failed to encode verification placeholder: {error}"))?,
        "verification placeholder",
    )?;
    write_text(
        &audit_path,
        &format!(
            "{} {}\n",
            unix_timestamp(),
            json!({
                "event": "task-workspace-created",
                "packetId": &packet_id,
                "workspaceId": &workspace_id
            })
        ),
        "task audit log",
    )?;

    Ok(TaskWorkspaceRecord {
        id: workspace_id,
        packet_id,
        root_path: workspace_root.display().to_string(),
        packet_path: packet_path.display().to_string(),
        task_markdown_path: task_markdown_path.display().to_string(),
        artifacts_path: artifacts_path.display().to_string(),
        logs_path: logs_path.display().to_string(),
        result_path: result_path.display().to_string(),
        verification_path: verification_path.display().to_string(),
    })
}

pub(crate) fn create_task_workspace(
    app: &AppHandle,
    request: CreateTaskWorkspaceRequest,
) -> Result<TaskWorkspaceRecord, String> {
    let root = task_workspaces_dir(app)?;
    create_task_workspace_with_root(&root, request)
}

#[cfg(test)]
mod tests {
    use super::{create_task_workspace_with_root, CreateTaskWorkspaceRequest};
    use serde_json::json;
    use std::fs;

    #[test]
    fn creates_execution_free_task_workspace_files() {
        let root = std::env::temp_dir().join(format!(
            "resonantos-task-workspace-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let result = create_task_workspace_with_root(
            &root,
            CreateTaskWorkspaceRequest {
                packet: json!({
                    "id": "delegation-1",
                    "workspaceId": "workspace-engineer-1",
                    "targetAgentId": "setup.core"
                }),
                task_markdown: "# TASK.md\n\nDo the diagnostic planning only.\n".to_string(),
            },
        )
        .expect("workspace should be created");

        assert_eq!(result.packet_id, "delegation-1");
        assert!(root
            .join("workspace-engineer-1")
            .join("delegation.packet.json")
            .exists());
        assert!(root.join("workspace-engineer-1").join("TASK.md").exists());
        assert!(root.join("workspace-engineer-1").join("artifacts").is_dir());
        assert!(root
            .join("workspace-engineer-1")
            .join("logs")
            .join("audit.jsonl")
            .exists());
        assert!(root
            .join("workspace-engineer-1")
            .join("verification.json")
            .exists());

        let _ = fs::remove_dir_all(root);
    }
}
