//! Minimal local chat via **Ollama** — the one provider usable with no API key, so
//! the Dev Assistant has a real local brain right now. The full multi-provider +
//! streaming + Ask/Edit layer is P4; this is deliberately small and non-streaming.

use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const DEFAULT_HOST: &str = "http://localhost:11434";

/// One chat turn. `role` is "system" | "user" | "assistant".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

/// The assistant's reply plus which model/provider produced it (for provenance).
#[derive(Debug, Clone, Serialize)]
pub struct ChatReply {
    pub content: String,
    pub model: String,
    pub provider: String,
}

fn host() -> String {
    std::env::var("OLLAMA_HOST")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_HOST.to_string())
}

/// Locally-pulled Ollama models (empty when Ollama is down or has none).
pub fn ollama_models() -> Vec<String> {
    let url = format!("{}/api/tags", host());
    let resp = match ureq::get(&url).timeout(Duration::from_secs(3)).call() {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let v: serde_json::Value = match resp.into_json() {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    v.get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// Pick a model: the caller's choice if available, else a Qwen model, else the first.
fn pick_model(requested: Option<&str>, available: &[String]) -> Option<String> {
    if let Some(m) = requested {
        if available.iter().any(|a| a == m) {
            return Some(m.to_string());
        }
    }
    available
        .iter()
        .find(|a| a.to_lowercase().contains("qwen"))
        .cloned()
        .or_else(|| available.first().cloned())
}

/// Send a chat turn to Ollama (non-streaming) and return the assistant reply.
pub fn ollama_chat(messages: &[ChatMsg], model: Option<&str>) -> Result<ChatReply> {
    let available = ollama_models();
    if available.is_empty() {
        anyhow::bail!(
            "No local Ollama model is available. Start Ollama and pull one, e.g. `ollama pull qwen3`."
        );
    }
    let model = pick_model(model, &available)
        .ok_or_else(|| anyhow::anyhow!("no usable Ollama model"))?;

    let url = format!("{}/api/chat", host());
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": false,
    });

    match ureq::post(&url).timeout(Duration::from_secs(120)).send_json(body) {
        Ok(resp) => {
            let v: serde_json::Value = resp.into_json().context("parsing Ollama reply")?;
            let content = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            Ok(ChatReply {
                content,
                model,
                provider: "ollama".into(),
            })
        }
        Err(ureq::Error::Status(code, r)) => {
            let detail = r.into_string().unwrap_or_default();
            anyhow::bail!("Ollama returned {code}: {detail}");
        }
        Err(ureq::Error::Transport(t)) => {
            anyhow::bail!("Could not reach Ollama at {}: {t}", host());
        }
    }
}
