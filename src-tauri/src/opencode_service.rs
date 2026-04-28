// Intent citation: docs/architecture/ADR-006-addon-runtime-sdk.md
// Intent citation: docs/architecture/ADR-015-delegation-fabric-addon-catalog-native-tools.md

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
#[cfg(target_os = "macos")]
use std::path::Path;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const DEFAULT_OPENCODE_PORT: u16 = 4096;
const OPENCODE_HOSTNAME: &str = "127.0.0.1";
const OPENCODE_SESSION_ID: &str = "opencode-main";
const OPENCODE_HEALTH_TIMEOUT: Duration = Duration::from_secs(8);

static OPENCODE_SESSIONS: OnceLock<Mutex<HashMap<String, OpenCodeProcessSession>>> =
    OnceLock::new();

fn opencode_sessions() -> &'static Mutex<HashMap<String, OpenCodeProcessSession>> {
    OPENCODE_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct OpenCodeProcessSession {
    child: Child,
    workspace_path: String,
    port: u16,
    mode: OpenCodeLaunchMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum OpenCodeLaunchMode {
    Web,
    Serve,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenCodeStatus {
    pub(crate) installed: bool,
    pub(crate) version: Option<String>,
    pub(crate) binary_path: Option<String>,
    pub(crate) install_hint: String,
    pub(crate) supports_web_ui: bool,
    pub(crate) supports_server_api: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenCodeStartRequest {
    pub(crate) workspace_path: String,
    pub(crate) port: Option<u16>,
    pub(crate) mode: Option<OpenCodeLaunchMode>,
    pub(crate) session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenCodeStopRequest {
    pub(crate) session_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenCodeServiceResult {
    pub(crate) session_id: String,
    pub(crate) workspace_path: String,
    pub(crate) mode: OpenCodeLaunchMode,
    pub(crate) api_base_url: String,
    pub(crate) web_url: String,
    pub(crate) command: String,
    pub(crate) pid: Option<u32>,
    pub(crate) already_running: bool,
}

pub(crate) fn query_opencode_status() -> OpenCodeStatus {
    let binary_path = resolve_opencode_binary();
    let version = binary_path
        .as_deref()
        .map(Command::new)
        .or_else(|| Some(Command::new("opencode")))
        .and_then(|mut command| {
            command
                .arg("--version")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .ok()
        })
        .and_then(|output| {
            if output.status.success() {
                Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
            } else {
                None
            }
        })
        .filter(|value| !value.is_empty());

    OpenCodeStatus {
        installed: binary_path.is_some() || version.is_some(),
        version,
        binary_path,
        install_hint:
            "Install the optional OpenCode runtime with the OpenCode desktop app, `npm install -g opencode-ai`, or the official installer."
                .to_string(),
        supports_web_ui: true,
        supports_server_api: true,
    }
}

pub(crate) fn start_opencode_service(
    request: OpenCodeStartRequest,
) -> Result<OpenCodeServiceResult, String> {
    if !query_opencode_status().installed {
        return Err("OpenCode is not installed. Install `opencode-ai` before launching this optional add-on.".to_string());
    }
    let binary = resolve_opencode_binary().unwrap_or_else(|| "opencode".to_string());

    let workspace = validate_workspace_path(&request.workspace_path)?;
    let session_id = request
        .session_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| OPENCODE_SESSION_ID.to_string());
    let port = match request.port {
        Some(port) => port,
        None => available_local_port().unwrap_or(DEFAULT_OPENCODE_PORT),
    };
    let mode = request.mode.unwrap_or(OpenCodeLaunchMode::Web);

    let mut sessions = opencode_sessions()
        .lock()
        .map_err(|_| "OpenCode session lock is poisoned.".to_string())?;
    if let Some(existing) = sessions.get_mut(&session_id) {
        if existing
            .child
            .try_wait()
            .map_err(|error| format!("Failed to inspect existing OpenCode process: {error}"))?
            .is_none()
        {
            return Ok(service_result(
                session_id,
                existing.workspace_path.clone(),
                existing.port,
                existing.mode.clone(),
                existing.child.id(),
                true,
            ));
        }
        sessions.remove(&session_id);
    }

    let mode_arg = match mode {
        OpenCodeLaunchMode::Web => "web",
        OpenCodeLaunchMode::Serve => "serve",
    };
    let child = Command::new(&binary)
        .arg(mode_arg)
        .arg("--hostname")
        .arg(OPENCODE_HOSTNAME)
        .arg("--port")
        .arg(port.to_string())
        .arg("--cors")
        .arg("tauri://localhost")
        .arg("--cors")
        .arg("http://localhost:1430")
        .arg("--cors")
        .arg("http://127.0.0.1:1430")
        .current_dir(&workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Failed to start OpenCode {mode_arg} with {binary}: {error}"))?;
    let pid = child.id();

    sessions.insert(
        session_id.clone(),
        OpenCodeProcessSession {
            child,
            workspace_path: workspace.display().to_string(),
            port,
            mode: mode.clone(),
        },
    );
    wait_for_opencode_health(port)?;

    Ok(service_result(
        session_id,
        workspace.display().to_string(),
        port,
        mode,
        pid,
        false,
    ))
}

pub(crate) fn stop_opencode_service(
    request: OpenCodeStopRequest,
) -> Result<OpenCodeServiceResult, String> {
    let session_id = request
        .session_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| OPENCODE_SESSION_ID.to_string());
    let mut sessions = opencode_sessions()
        .lock()
        .map_err(|_| "OpenCode session lock is poisoned.".to_string())?;
    let Some(mut session) = sessions.remove(&session_id) else {
        return Err(format!(
            "No OpenCode service session is running: {session_id}"
        ));
    };
    let pid = session.child.id();
    let _ = session.child.kill();
    let _ = session.child.wait();
    Ok(service_result(
        session_id,
        session.workspace_path,
        session.port,
        session.mode,
        pid,
        false,
    ))
}

fn validate_workspace_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if !path.exists() {
        return Err(format!("OpenCode workspace path does not exist: {value}"));
    }
    if !path.is_dir() {
        return Err(format!(
            "OpenCode workspace path is not a directory: {value}"
        ));
    }
    path.canonicalize()
        .map_err(|error| format!("Failed to resolve OpenCode workspace path: {error}"))
}

fn service_result(
    session_id: String,
    workspace_path: String,
    port: u16,
    mode: OpenCodeLaunchMode,
    pid: u32,
    already_running: bool,
) -> OpenCodeServiceResult {
    let api_base_url = format!("http://{OPENCODE_HOSTNAME}:{port}");
    OpenCodeServiceResult {
        session_id,
        workspace_path,
        mode,
        api_base_url: api_base_url.clone(),
        web_url: api_base_url,
        command: "opencode web|serve --hostname 127.0.0.1 --port <port>".to_string(),
        pid: Some(pid),
        already_running,
    }
}

fn available_local_port() -> Option<u16> {
    TcpListener::bind((OPENCODE_HOSTNAME, 0))
        .ok()
        .and_then(|listener| listener.local_addr().ok().map(|address| address.port()))
}

fn wait_for_opencode_health(port: u16) -> Result<(), String> {
    let deadline = Instant::now() + OPENCODE_HEALTH_TIMEOUT;
    while Instant::now() < deadline {
        if opencode_health_ready(port) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(150));
    }
    Err(format!(
        "OpenCode started but did not become healthy on {OPENCODE_HOSTNAME}:{port} within {}s.",
        OPENCODE_HEALTH_TIMEOUT.as_secs()
    ))
}

fn opencode_health_ready(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect((OPENCODE_HOSTNAME, port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /global/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok()
        && response.starts_with("HTTP/1.1 200")
        && response.contains("\"healthy\":true")
}

fn resolve_opencode_binary() -> Option<String> {
    let command = if cfg!(target_os = "windows") {
        ("where", vec!["opencode"])
    } else {
        ("which", vec!["opencode"])
    };
    Command::new(command.0)
        .args(command.1)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(ToOwned::to_owned)
        })
        .or_else(resolve_opencode_app_binary)
}

fn resolve_opencode_app_binary() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let path = "/Applications/OpenCode.app/Contents/MacOS/opencode-cli";
        if Path::new(path).is_file() {
            return Some(path.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{service_result, validate_workspace_path, OpenCodeLaunchMode};

    #[test]
    fn rejects_missing_workspace_path_before_launch() {
        assert!(validate_workspace_path("/definitely/not/a/real/opencode/workspace").is_err());
    }

    #[test]
    fn builds_local_only_service_urls() {
        let result = service_result(
            "test".to_string(),
            "/tmp/work".to_string(),
            4096,
            OpenCodeLaunchMode::Web,
            42,
            false,
        );
        assert_eq!(result.api_base_url, "http://127.0.0.1:4096");
        assert_eq!(result.web_url, "http://127.0.0.1:4096");
    }

    #[test]
    fn allocates_ephemeral_local_port() {
        let port = super::available_local_port().expect("local port should be available");
        assert!(port > 0);
    }
}
