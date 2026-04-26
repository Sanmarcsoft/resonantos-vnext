// Intent citation: docs/architecture/ADR-007-living-archive-boundaries.md
// Intent citation: docs/architecture/ADR-012-living-archive-approval-policy.md

use std::fs;
use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::provider_service::{
    execute_provider_service_chat, ChatMessageInput, ProviderServiceChatRequest,
};

use super::{
    open_archive_db, parse_frontmatter, resolve_document_path, resolve_source_path, slugify,
    source_id_from_path, string_field, unix_timestamp, ArchiveProcessIngestRequest,
    ArchiveProcessIngestResult, ArchivePromoteReviewArtifactRequest,
    ArchivePromoteReviewArtifactResult, ArchivePromotedPage, ArchiveReviewArtifact,
    ArchiveReviewDecision, ArchiveReviewDecisionRequest, ArchiveReviewDecisionResult,
    ArchiveRuntime, ArchiveSkippedPage,
};

fn normalize_confidence(value: Option<&Value>) -> String {
    match value
        .and_then(Value::as_str)
        .unwrap_or("medium")
        .to_ascii_lowercase()
        .as_str()
    {
        "high" => "high".to_string(),
        "low" => "low".to_string(),
        _ => "medium".to_string(),
    }
}

fn normalize_doctrine_sensitivity(value: Option<&Value>, source_type: &str) -> String {
    let explicit = value
        .and_then(Value::as_str)
        .map(|raw| raw.to_ascii_lowercase());
    if let Some(level) = explicit {
        return match level.as_str() {
            "high" => "high".to_string(),
            "low" => "low".to_string(),
            _ => "medium".to_string(),
        };
    }

    match source_type {
        "constitution" | "protocol" | "philosophy" | "manifesto" => "high".to_string(),
        "summary" | "analysis" => "medium".to_string(),
        _ => "low".to_string(),
    }
}

fn proposed_page_types(proposed_pages: &[Value]) -> Vec<String> {
    proposed_pages
        .iter()
        .filter_map(|page| {
            page.get("type")
                .and_then(Value::as_str)
                .map(|value| value.to_ascii_lowercase())
        })
        .collect()
}

pub(super) fn evaluate_approval_tier(
    source_type: &str,
    intent: &str,
    confidence: &str,
    doctrine_sensitivity: &str,
    proposed_pages: &[Value],
) -> (String, String) {
    let page_types = proposed_page_types(proposed_pages);
    let has_high_impact_page = page_types
        .iter()
        .any(|page_type| page_type == "synthesis" || page_type == "future-asset");
    let doctrine_sensitive_source = matches!(
        source_type,
        "constitution" | "protocol" | "philosophy" | "manifesto"
    );

    if confidence == "low" {
        return (
            "human-review".to_string(),
            "Low-confidence ingest must be escalated to human review before trusted promotion."
                .to_string(),
        );
    }

    if doctrine_sensitivity == "high" || doctrine_sensitive_source || has_high_impact_page {
        return (
            "human-review".to_string(),
            "Doctrine-sensitive or high-impact archive promotion requires human review."
                .to_string(),
        );
    }

    if matches!(intent, "summary-refresh" | "metadata-refresh")
        && confidence == "high"
        && doctrine_sensitivity == "low"
    {
        return (
            "auto-approve".to_string(),
            "This request matches the narrow low-risk refresh policy and can be auto-approved."
                .to_string(),
        );
    }

    (
        "strategist-review".to_string(),
        "Strategist review is the default approval tier for trusted archive promotion.".to_string(),
    )
}

fn parse_proposed_pages(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

fn collect_string_values(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(ToString::to_string)
            .collect(),
        Some(Value::String(raw)) => raw
            .trim_matches(|character| character == '[' || character == ']')
            .split(',')
            .map(str::trim)
            .map(|item| item.trim_matches('"'))
            .filter(|item| !item.is_empty())
            .map(ToString::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn merge_source_ids(page: &Value, default_source_id: &str) -> Vec<String> {
    let mut sources = Vec::new();
    for source in collect_string_values(page.get("sources")) {
        if !sources.contains(&source) {
            sources.push(source);
        }
    }
    if !sources.iter().any(|source| source == default_source_id) {
        sources.push(default_source_id.to_string());
    }
    sources
}

pub(super) fn wiki_page_subdir(page_type: &str) -> Option<&'static str> {
    match page_type.to_ascii_lowercase().as_str() {
        "summary" => Some("summaries"),
        "entity" => Some("entities"),
        "concept" => Some("concepts"),
        "synthesis" => Some("syntheses"),
        _ => None,
    }
}

pub(super) fn render_promoted_page(
    page: &Value,
    page_type: &str,
    page_id: &str,
    title: &str,
    created_at: &str,
    source_path: &str,
    source_ids: &[String],
    artifact_file: &str,
    promoted_at: &str,
    existing_body: Option<&str>,
) -> (String, Value, String) {
    let promoted_body = string_field(
        page,
        &["content", "body", "markdown", "summary", "description"],
    )
    .unwrap_or("No body was supplied by the review artifact.");
    let stage = string_field(page, &["stage"])
        .filter(|value| matches!(*value, "stub" | "developing" | "mature"))
        .unwrap_or(if page_type == "summary" {
            "mature"
        } else {
            "developing"
        });
    let source_yaml = source_ids
        .iter()
        .map(|source| format!("  - \"{}\"", source.replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join("\n");
    let frontmatter = json!({
        "id": page_id,
        "type": page_type,
        "title": title,
        "created": created_at,
        "updated": promoted_at,
        "stage": stage,
        "sources": source_ids,
        "source_path": source_path,
        "review_artifact": artifact_file,
    });

    let body = merge_promoted_page_body(
        existing_body,
        title,
        promoted_body,
        source_path,
        artifact_file,
        promoted_at,
    );
    let content = format!(
        "---\nid: {page_id}\ntype: {page_type}\ntitle: \"{}\"\ncreated: {created_at}\nupdated: {promoted_at}\nstage: {stage}\nsources:\n{}\nsource_path: \"{}\"\nreview_artifact: \"{}\"\n---\n\n{}\n",
        title.replace('"', "\\\""),
        source_yaml,
        source_path.replace('"', "\\\""),
        artifact_file.replace('"', "\\\""),
        body
    );
    (content, frontmatter, body)
}

pub(super) fn merge_promoted_page_body(
    existing_body: Option<&str>,
    title: &str,
    promoted_body: &str,
    source_path: &str,
    artifact_file: &str,
    promoted_at: &str,
) -> String {
    let marker = format!("<!-- resonantos-promote:{} -->", slugify(artifact_file));
    if let Some(existing_body) = existing_body.map(str::trim).filter(|body| !body.is_empty()) {
        if existing_body.contains(&marker) {
            return existing_body.to_string();
        }
        return format!(
            "{existing_body}\n\n---\n\n{marker}\n## Promoted Update ({promoted_at})\n\n**Source:** `{source_path}`  \n**Review Artifact:** `{artifact_file}`\n\n{}",
            promoted_body.trim()
        );
    }

    format!("# {title}\n\n{}", promoted_body.trim())
}

fn parse_review_decision(payload: &Value) -> ArchiveReviewDecision {
    let decision = payload.get("decision").and_then(Value::as_object);
    ArchiveReviewDecision {
        status: decision
            .and_then(|item| item.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("pending")
            .to_string(),
        action: decision
            .and_then(|item| item.get("action"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        actor_id: decision
            .and_then(|item| item.get("actorId"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        decided_at: decision
            .and_then(|item| item.get("decidedAt"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        tier_applied: decision
            .and_then(|item| item.get("tierApplied"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        notes: decision
            .and_then(|item| item.get("notes"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
    }
}

fn parse_review_artifact(artifact_file: PathBuf, payload: &Value) -> ArchiveReviewArtifact {
    let result = payload.get("result").unwrap_or(payload);
    ArchiveReviewArtifact {
        artifact_file: artifact_file.display().to_string(),
        checked_at: payload
            .get("checkedAt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        request_file: payload
            .get("requestFile")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        source_path: payload
            .get("sourcePath")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        source_type: payload
            .get("sourceType")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        source_role: payload
            .get("sourceRole")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        intent: payload
            .get("intent")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        provider_id: payload
            .get("providerId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        model: payload
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        summary: result
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("Review artifact created.")
            .to_string(),
        confidence: normalize_confidence(result.get("confidence")),
        doctrine_sensitivity: payload
            .get("policy")
            .and_then(|value| value.get("doctrineSensitivity"))
            .and_then(Value::as_str)
            .unwrap_or("medium")
            .to_string(),
        recommended_tier: payload
            .get("policy")
            .and_then(|value| value.get("recommendedTier"))
            .and_then(Value::as_str)
            .unwrap_or("strategist-review")
            .to_string(),
        recommendation_reason: payload
            .get("policy")
            .and_then(|value| value.get("recommendationReason"))
            .and_then(Value::as_str)
            .unwrap_or("Strategist review is the default approval tier.")
            .to_string(),
        proposed_pages: parse_proposed_pages(result.get("proposed_pages")),
        decision: parse_review_decision(payload),
    }
}

pub(super) struct PromotedPageIndexInput<'a> {
    pub(super) page_id: &'a str,
    pub(super) page_type: &'a str,
    pub(super) title: &'a str,
    pub(super) file_path: &'a str,
    pub(super) stage: &'a str,
    pub(super) frontmatter: &'a Value,
    pub(super) body: &'a str,
    pub(super) source_id: &'a str,
    pub(super) source_title: &'a str,
    pub(super) source_type: &'a str,
    pub(super) source_path: &'a str,
    pub(super) promoted_at: &'a str,
}

fn existing_page_created_at(
    connection: &Connection,
    page_id: &str,
) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT created FROM pages WHERE id = ?1",
            params![page_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read existing archive page index row: {error}"))
}

pub(super) fn upsert_promoted_page_index(
    connection: &Connection,
    input: PromotedPageIndexInput<'_>,
) -> Result<String, String> {
    let existing_created = existing_page_created_at(connection, input.page_id)?;
    let created_at = existing_created.unwrap_or_else(|| input.promoted_at.to_string());
    let frontmatter_json = serde_json::to_string(input.frontmatter)
        .map_err(|error| format!("Failed to encode promoted page frontmatter: {error}"))?;

    connection
        .execute(
            "INSERT INTO pages (id, type, title, file_path, created, updated, stage, frontmatter, content)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                file_path = excluded.file_path,
                updated = excluded.updated,
                stage = excluded.stage,
                frontmatter = excluded.frontmatter,
                content = excluded.content",
            params![
                input.page_id,
                input.page_type,
                input.title,
                input.file_path,
                created_at,
                input.promoted_at,
                input.stage,
                frontmatter_json,
                input.body,
            ],
        )
        .map_err(|error| format!("Failed to update promoted page archive index: {error}"))?;

    connection
        .execute(
            "INSERT OR IGNORE INTO sources (id, title, type, raw_path, added_at, processed, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
            params![
                input.source_id,
                input.source_title,
                input.source_type,
                input.source_path,
                input.promoted_at,
                json!({"registeredBy": "resonantos-vnext"}).to_string(),
            ],
        )
        .map_err(|error| format!("Failed to register promoted page source in archive index: {error}"))?;
    connection
        .execute(
            "UPDATE sources SET processed = 1 WHERE id = ?1 OR raw_path = ?2",
            params![input.source_id, input.source_path],
        )
        .map_err(|error| format!("Failed to mark promoted page source as processed: {error}"))?;

    let indexed_source_id = connection
        .query_row(
            "SELECT id FROM sources WHERE raw_path = ?1 OR id = ?2 ORDER BY CASE WHEN id = ?2 THEN 0 ELSE 1 END LIMIT 1",
            params![input.source_path, input.source_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Failed to resolve promoted page source index row: {error}"))?
        .unwrap_or_else(|| input.source_id.to_string());

    connection
        .execute(
            "INSERT OR IGNORE INTO page_sources (page_id, source_id) VALUES (?1, ?2)",
            params![input.page_id, indexed_source_id],
        )
        .map_err(|error| {
            format!("Failed to link promoted page to source in archive index: {error}")
        })?;

    Ok(created_at)
}

pub(crate) fn list_archive_review_artifacts(
    app: &AppHandle,
) -> Result<Vec<ArchiveReviewArtifact>, String> {
    let runtime = ArchiveRuntime::resolve(app)?;
    let artifacts_root = runtime.review_queue_root().join("artifacts");
    if !artifacts_root.exists() {
        return Ok(Vec::new());
    }

    let mut artifacts = Vec::new();
    for entry in fs::read_dir(&artifacts_root)
        .map_err(|error| format!("Failed to read archive review artifacts: {error}"))?
    {
        let path = entry
            .map_err(|error| format!("Failed to read archive review artifact entry: {error}"))?
            .path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let raw = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read archive review artifact: {error}"))?;
        let payload = serde_json::from_str::<Value>(&raw)
            .map_err(|error| format!("Invalid archive review artifact JSON: {error}"))?;
        artifacts.push(parse_review_artifact(path, &payload));
    }
    artifacts.sort_by(|left, right| right.checked_at.cmp(&left.checked_at));
    Ok(artifacts)
}

pub(crate) async fn process_archive_ingest_request(
    app: &AppHandle,
    request: ArchiveProcessIngestRequest,
) -> Result<ArchiveProcessIngestResult, String> {
    let runtime = ArchiveRuntime::resolve(app)?;
    let request_path = resolve_document_path(&runtime, &request.request_file)?;
    let request_raw = fs::read_to_string(&request_path)
        .map_err(|error| format!("Failed to read queued archive ingest request: {error}"))?;
    let payload = serde_json::from_str::<Value>(&request_raw)
        .map_err(|error| format!("Invalid queued archive ingest request JSON: {error}"))?;

    let source_path = payload
        .get("sourcePath")
        .and_then(Value::as_str)
        .ok_or_else(|| "Queued ingest request is missing sourcePath.".to_string())?;
    let source_type = payload
        .get("sourceType")
        .and_then(Value::as_str)
        .unwrap_or("note");
    let source_role = payload
        .get("sourceRole")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let intent = payload
        .get("intent")
        .and_then(Value::as_str)
        .unwrap_or("review-and-ingest");
    let queued_at = payload
        .get("queuedAt")
        .and_then(Value::as_str)
        .unwrap_or_default();

    let resolved_source = resolve_source_path(&runtime, source_path);
    if !resolved_source.exists() {
        return Err(format!(
            "Archive ingest source does not exist: {}",
            resolved_source.display()
        ));
    }

    let source_content = fs::read_to_string(&resolved_source)
        .map_err(|error| format!("Failed to read archive ingest source: {error}"))?;
    let truncated_content = if source_content.chars().count() > 16_000 {
        source_content.chars().take(16_000).collect::<String>()
    } else {
        source_content.clone()
    };

    let prompt_file = runtime.config_root.join("INGEST_AGENT_SYSTEM_PROMPT.md");
    let ingest_prompt = if prompt_file.exists() {
        fs::read_to_string(&prompt_file)
            .map_err(|error| format!("Failed to read ingest agent system prompt: {error}"))?
    } else {
        "You are the Resonant Ingest Agent. Produce a structured archive review draft from the provided source without writing trusted knowledge pages directly.".to_string()
    };

    let system_prompt = [
        ingest_prompt.as_str(),
        "You are processing a queued Living Archive ingest request for review, not directly mutating trusted wiki knowledge.",
        "Return strict JSON with these top-level keys:",
        "summary, claims, entities, concepts, process_signals, tensions, open_questions, doctrine_alignment, confidence, doctrine_sensitivity, needs_review, review_reason, proposed_pages.",
        "Do not wrap the JSON in markdown fences.",
    ]
    .join("\n\n");

    let reply = execute_provider_service_chat(
        app,
        ProviderServiceChatRequest {
            provider_id: request.provider_id.clone(),
            provider_type: request.provider_type,
            api_base_url: request.api_base_url,
            runtime_node_id: request.runtime_node_id,
            runtime_node_kind: request.runtime_node_kind,
            runtime_node_endpoint: request.runtime_node_endpoint,
            auth_tier: request.auth_tier,
            model: request.model.clone(),
            reasoning_effort: "high".to_string(),
            system_prompt,
            messages: vec![ChatMessageInput {
                role: "user".to_string(),
                content: format!(
                    "Queued at: {queued_at}\nIntent: {intent}\nSource type: {source_type}\nSource role: {}\nSource path: {}\n\nSource content:\n{}",
                    source_role.as_deref().unwrap_or("unknown"),
                    resolved_source.display(),
                    truncated_content
                ),
            }],
        },
    )
    .await?;

    let parsed = serde_json::from_str::<Value>(&reply).unwrap_or_else(|_| {
        json!({
            "summary": reply,
            "claims": [],
            "entities": [],
            "concepts": [],
            "process_signals": [],
            "tensions": [],
            "open_questions": [],
            "doctrine_alignment": "unknown",
            "confidence": "low",
            "doctrine_sensitivity": "medium",
            "needs_review": true,
            "review_reason": "Ingest response was not valid JSON.",
            "proposed_pages": []
        })
    });

    let confidence = normalize_confidence(parsed.get("confidence"));
    let doctrine_sensitivity =
        normalize_doctrine_sensitivity(parsed.get("doctrine_sensitivity"), source_type);
    let proposed_pages = parse_proposed_pages(parsed.get("proposed_pages"));
    let (recommended_tier, recommendation_reason) = evaluate_approval_tier(
        source_type,
        intent,
        &confidence,
        &doctrine_sensitivity,
        &proposed_pages,
    );

    let checked_at = unix_timestamp();
    let artifacts_root = runtime.review_queue_root().join("artifacts");
    let processed_root = runtime.review_queue_root().join("processed");
    fs::create_dir_all(&artifacts_root)
        .map_err(|error| format!("Failed to create archive review artifact root: {error}"))?;
    fs::create_dir_all(&processed_root)
        .map_err(|error| format!("Failed to create archive processed request root: {error}"))?;

    let source_stem = resolved_source
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("source");
    let review_artifact_file = artifacts_root.join(format!(
        "{}-{}.json",
        checked_at.replace(':', "-"),
        slugify(&format!("{source_type}-{source_stem}"))
    ));
    let decision = if recommended_tier == "auto-approve" {
        json!({
            "status": "approved",
            "action": "approve",
            "actorId": "policy.auto",
            "decidedAt": checked_at,
            "tierApplied": "auto-approve",
            "notes": "Auto-approved by archive approval policy."
        })
    } else {
        json!({
            "status": "pending"
        })
    };
    let artifact_payload = json!({
        "checkedAt": checked_at,
        "requestFile": request_path.display().to_string(),
        "sourcePath": resolved_source.display().to_string(),
        "sourceType": source_type,
        "sourceRole": source_role,
        "intent": intent,
        "providerId": request.provider_id,
        "model": request.model,
        "policy": {
            "confidence": confidence,
            "doctrineSensitivity": doctrine_sensitivity,
            "recommendedTier": recommended_tier,
            "recommendationReason": recommendation_reason,
        },
        "decision": decision,
        "result": parsed,
    });
    fs::write(
        &review_artifact_file,
        serde_json::to_string_pretty(&artifact_payload)
            .map_err(|error| format!("Failed to encode archive review artifact: {error}"))?,
    )
    .map_err(|error| format!("Failed to write archive review artifact: {error}"))?;

    let archived_request_file = processed_root.join(
        request_path
            .file_name()
            .ok_or_else(|| "Queued request path is missing a filename.".to_string())?,
    );
    fs::rename(&request_path, &archived_request_file)
        .map_err(|error| format!("Failed to archive processed ingest request: {error}"))?;

    if let Some(connection) = open_archive_db(&runtime)? {
        let _ = connection.execute(
            "INSERT INTO activity_log (ts, action, details, agent_id) VALUES (?1, ?2, ?3, ?4)",
            params![
                checked_at,
                "ingest_review",
                artifact_payload.to_string(),
                "archive-ingest.core"
            ],
        );
    }

    Ok(ArchiveProcessIngestResult {
        request_file: request.request_file,
        archived_request_file: archived_request_file.display().to_string(),
        review_artifact_file: review_artifact_file.display().to_string(),
        summary: parsed
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("Review artifact created.")
            .to_string(),
        checked_at,
        review_artifact: parse_review_artifact(review_artifact_file.clone(), &artifact_payload),
    })
}

pub(crate) fn decide_archive_review_artifact(
    app: &AppHandle,
    request: ArchiveReviewDecisionRequest,
) -> Result<ArchiveReviewDecisionResult, String> {
    let runtime = ArchiveRuntime::resolve(app)?;
    let artifact_path = resolve_document_path(&runtime, &request.artifact_file)?;
    let raw = fs::read_to_string(&artifact_path)
        .map_err(|error| format!("Failed to read archive review artifact: {error}"))?;
    let mut payload = serde_json::from_str::<Value>(&raw)
        .map_err(|error| format!("Invalid archive review artifact JSON: {error}"))?;

    let recommended_tier = payload
        .get("policy")
        .and_then(|value| value.get("recommendedTier"))
        .and_then(Value::as_str)
        .unwrap_or("strategist-review")
        .to_string();
    let current_status = payload
        .get("decision")
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("pending");
    if current_status != "pending" {
        return Err("Archive review artifact already has a final decision.".to_string());
    }

    let action = request.action.as_str();
    if !matches!(action, "approve" | "reject" | "escalate") {
        return Err(
            "Archive review decision action must be approve, reject, or escalate.".to_string(),
        );
    }

    if action == "approve" && recommended_tier == "human-review" && request.actor_id != "human.user"
    {
        return Err(
            "This archive review artifact requires human review and cannot be approved by the Strategist.".to_string(),
        );
    }

    let decided_at = unix_timestamp();
    let resulting_status = match action {
        "approve" => "approved",
        "reject" => "rejected",
        "escalate" => "escalated",
        _ => "pending",
    };
    let tier_applied = if action == "approve" {
        recommended_tier.clone()
    } else if action == "escalate" {
        "human-review".to_string()
    } else {
        recommended_tier.clone()
    };

    let decision_value = json!({
        "status": resulting_status,
        "action": action,
        "actorId": request.actor_id,
        "decidedAt": decided_at,
        "tierApplied": tier_applied,
        "notes": request.notes,
    });

    if let Some(object) = payload.as_object_mut() {
        object.insert("decision".to_string(), decision_value.clone());
    }

    fs::write(
        &artifact_path,
        serde_json::to_string_pretty(&payload).map_err(|error| {
            format!("Failed to encode updated archive review artifact: {error}")
        })?,
    )
    .map_err(|error| format!("Failed to write updated archive review artifact: {error}"))?;

    if let Some(connection) = open_archive_db(&runtime)? {
        let _ = connection.execute(
            "INSERT INTO activity_log (ts, action, details, agent_id) VALUES (?1, ?2, ?3, ?4)",
            params![
                decided_at,
                "ingest_review_decision",
                json!({
                    "artifactFile": artifact_path.display().to_string(),
                    "status": resulting_status,
                    "action": action,
                    "tierApplied": tier_applied,
                    "recommendedTier": recommended_tier,
                })
                .to_string(),
                request.actor_id
            ],
        );
    }

    let summary = payload
        .get("result")
        .and_then(|value| value.get("summary"))
        .and_then(Value::as_str)
        .unwrap_or("Archive review decision recorded.")
        .to_string();

    Ok(ArchiveReviewDecisionResult {
        artifact_file: artifact_path.display().to_string(),
        status: resulting_status.to_string(),
        action: action.to_string(),
        actor_id: request.actor_id,
        decided_at,
        tier_applied,
        summary,
    })
}

pub(crate) fn promote_archive_review_artifact(
    app: &AppHandle,
    request: ArchivePromoteReviewArtifactRequest,
) -> Result<ArchivePromoteReviewArtifactResult, String> {
    let runtime = ArchiveRuntime::resolve(app)?;
    let artifact_path = resolve_document_path(&runtime, &request.artifact_file)?;
    let raw = fs::read_to_string(&artifact_path)
        .map_err(|error| format!("Failed to read archive review artifact: {error}"))?;
    let mut payload = serde_json::from_str::<Value>(&raw)
        .map_err(|error| format!("Invalid archive review artifact JSON: {error}"))?;
    let artifact = parse_review_artifact(artifact_path.clone(), &payload);

    if artifact.decision.status != "approved" {
        return Err(
            "Only approved archive review artifacts can be promoted to trusted wiki pages."
                .to_string(),
        );
    }

    let promoted_at = unix_timestamp();
    let artifact_file = artifact_path.display().to_string();
    let mut pages_written = Vec::new();
    let mut skipped_pages = Vec::new();
    let connection = open_archive_db(&runtime)?;
    let default_source_id = source_id_from_path(&artifact.source_path);
    let source_title = PathBuf::from(&artifact.source_path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(&artifact.source_path)
        .to_string();
    let backup_root = runtime
        .review_queue_root()
        .join("backups")
        .join(promoted_at.replace(':', "-"));

    for page in artifact.proposed_pages.iter() {
        let title = string_field(page, &["title", "name", "label"]).unwrap_or("Untitled page");
        let page_type = string_field(page, &["type", "page_type", "pageType"]).unwrap_or("unknown");
        let Some(subdir) = wiki_page_subdir(page_type) else {
            skipped_pages.push(ArchiveSkippedPage {
                title: title.to_string(),
                reason: format!("Unsupported trusted wiki page type `{page_type}`."),
            });
            continue;
        };

        let raw_id = string_field(page, &["id", "slug", "page_id", "pageId"]).unwrap_or(title);
        let page_id = slugify(raw_id);
        if page_id.is_empty() {
            skipped_pages.push(ArchiveSkippedPage {
                title: title.to_string(),
                reason: "Page id could not be normalized into a safe slug.".to_string(),
            });
            continue;
        }

        let page_dir = runtime.wiki_root.join(subdir);
        fs::create_dir_all(&page_dir)
            .map_err(|error| format!("Failed to create trusted wiki page directory: {error}"))?;
        let normalized_dir = page_dir
            .canonicalize()
            .map_err(|error| format!("Failed to resolve trusted wiki page directory: {error}"))?;
        let normalized_wiki_root = runtime
            .wiki_root
            .canonicalize()
            .map_err(|error| format!("Failed to resolve trusted wiki root: {error}"))?;
        if !normalized_dir.starts_with(&normalized_wiki_root) {
            return Err(
                "Trusted wiki promotion resolved outside the configured wiki root.".to_string(),
            );
        }

        let page_path = normalized_dir.join(format!("{page_id}.md"));
        let action = if page_path.exists() {
            "updated"
        } else {
            "created"
        }
        .to_string();
        let backup_path = if page_path.exists() {
            fs::create_dir_all(&backup_root).map_err(|error| {
                format!("Failed to create archive promotion backup root: {error}")
            })?;
            let backup_path = backup_root.join(format!("{subdir}-{page_id}.md"));
            fs::copy(&page_path, &backup_path).map_err(|error| {
                format!("Failed to back up existing trusted wiki page: {error}")
            })?;
            Some(backup_path)
        } else {
            None
        };

        let (existing_created_at, existing_body) = if page_path.exists() {
            let existing_raw = fs::read_to_string(&page_path)
                .map_err(|error| format!("Failed to read existing trusted wiki page: {error}"))?;
            let (frontmatter, body, _, _) = parse_frontmatter(&existing_raw);
            let created_at = frontmatter
                .get("created")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            (created_at, Some(body))
        } else {
            (None, None)
        };
        let created_at = existing_created_at.as_deref().unwrap_or(&promoted_at);
        let page_type_normalized = page_type.to_ascii_lowercase();
        let source_ids = merge_source_ids(page, &default_source_id);
        let (content, frontmatter, body) = render_promoted_page(
            page,
            &page_type_normalized,
            &page_id,
            title,
            created_at,
            &artifact.source_path,
            &source_ids,
            &artifact_file,
            &promoted_at,
            existing_body.as_deref(),
        );
        fs::write(&page_path, content)
            .map_err(|error| format!("Failed to write trusted wiki page: {error}"))?;
        let relative_file_path = page_path
            .strip_prefix(&runtime.vault_root)
            .unwrap_or(&page_path)
            .display()
            .to_string();
        let stage = frontmatter
            .get("stage")
            .and_then(Value::as_str)
            .unwrap_or("developing");
        let indexed = if let Some(connection) = connection.as_ref() {
            upsert_promoted_page_index(
                connection,
                PromotedPageIndexInput {
                    page_id: &page_id,
                    page_type: &page_type_normalized,
                    title,
                    file_path: &relative_file_path,
                    stage,
                    frontmatter: &frontmatter,
                    body: &body,
                    source_id: &default_source_id,
                    source_title: &source_title,
                    source_type: &artifact.source_type,
                    source_path: &artifact.source_path,
                    promoted_at: &promoted_at,
                },
            )?;
            true
        } else {
            false
        };

        pages_written.push(ArchivePromotedPage {
            page_type: page_type_normalized,
            page_id,
            title: title.to_string(),
            file_path: relative_file_path,
            merge_mode: if action == "updated" {
                "append-provenance-section".to_string()
            } else {
                "create-page".to_string()
            },
            action,
            backup_path: backup_path.map(|path| path.display().to_string()),
            source_id: default_source_id.clone(),
            indexed,
        });
    }

    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "promotion".to_string(),
            json!({
                "status": if pages_written.is_empty() { "no-op" } else { "promoted" },
                "actorId": request.actor_id,
                "promotedAt": promoted_at,
                "pagesWritten": pages_written.len(),
                "pagesSkipped": skipped_pages.len(),
            }),
        );
    }
    fs::write(
        &artifact_path,
        serde_json::to_string_pretty(&payload).map_err(|error| {
            format!("Failed to encode promoted archive review artifact: {error}")
        })?,
    )
    .map_err(|error| format!("Failed to update promoted archive review artifact: {error}"))?;

    if let Some(connection) = connection.as_ref() {
        let page_ids = pages_written
            .iter()
            .map(|page| page.page_id.clone())
            .collect::<Vec<_>>();
        let _ = connection.execute(
            "INSERT INTO activity_log (ts, action, details, agent_id) VALUES (?1, ?2, ?3, ?4)",
            params![
                promoted_at,
                "trusted_wiki_promote",
                json!({
                    "artifactFile": artifact_file,
                    "pagesWritten": pages_written.len(),
                    "pagesSkipped": skipped_pages.len(),
                    "pageIds": page_ids,
                })
                .to_string(),
                request.actor_id
            ],
        );
    }

    Ok(ArchivePromoteReviewArtifactResult {
        artifact_file,
        promoted_at,
        actor_id: request.actor_id,
        pages_written,
        skipped_pages,
    })
}
