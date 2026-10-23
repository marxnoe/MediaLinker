//! YouTube -> mp4 / mp3 (yt-dlp + ffmpeg).

use std::{
    path::PathBuf,
    process::Stdio,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

use axum::{Json, extract::State, http::StatusCode};
use serde::Deserialize;
use serde_json::json;
use tokio::{io::AsyncReadExt, process::Command};

use crate::{ApiError, AppStateRef, random_id};

const YT_HOSTS: &[&str] = &[
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
];
const YT_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
pub struct Jobs(AtomicUsize);

/// Releases the job slot and deletes leftover `<id>.*` files, also when the client disconnects
/// (axum drops the handler future, and `kill_on_drop` stops yt-dlp).
struct Job<'a> {
    jobs: &'a Jobs,
    dir: PathBuf,
    id: String,
    keep: Option<String>,
}

impl Drop for Job<'_> {
    fn drop(&mut self) {
        self.jobs.0.fetch_sub(1, Ordering::SeqCst);
        let prefix = format!("{}.", self.id);
        if let Ok(entries) = std::fs::read_dir(&self.dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if name.starts_with(&prefix) && self.keep.as_deref() != Some(&name) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
}

#[derive(Deserialize)]
pub struct Request {
    url: Option<String>,
    format: Option<String>,
}

pub async fn handler(
    State(s): State<AppStateRef>,
    Json(req): Json<Request>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let parsed = req
        .url
        .as_deref()
        .and_then(|u| url::Url::parse(u).ok())
        .ok_or_else(|| ApiError::bad("Invalid URL"))?;
    if !matches!(parsed.scheme(), "http" | "https") || !YT_HOSTS.contains(&parsed.host_str().unwrap_or_default()) {
        return Err(ApiError::bad("Only YouTube links are supported"));
    }
    let format = match req.format.as_deref() {
        Some(f @ ("mp4" | "mp3")) => f,
        _ => return Err(ApiError::bad("Format must be mp4 or mp3")),
    };
    if s.yt.0.fetch_add(1, Ordering::SeqCst) >= s.cfg.yt_max_jobs {
        s.yt.0.fetch_sub(1, Ordering::SeqCst);
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Server is busy, try again in a minute".into(),
        ));
    }
    let mut job = Job {
        jobs: &s.yt,
        dir: s.cfg.upload_dir.clone(),
        id: random_id(),
        keep: None,
    };

    let mut cmd = Command::new("yt-dlp");
    cmd.args(["--no-playlist", "--no-warnings", "--js-runtimes", "node"]);
    if let Some(proxy) = &s.cfg.yt_proxy {
        cmd.args(["--proxy", proxy]);
    }
    cmd.arg("--max-filesize").arg(format!("{}M", s.cfg.max_mb));
    cmd.arg("-o").arg(job.dir.join(format!("{}.%(ext)s", job.id)));
    if format == "mp3" {
        cmd.args(["-x", "--audio-format", "mp3", "--audio-quality", "0"]);
    } else {
        cmd.args([
            "-f",
            "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
            "--merge-output-format",
            "mp4",
        ]);
    }
    cmd.args(["--", parsed.as_str()]);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "yt-dlp is not available on the server".into(),
        )
    })?;
    let mut stderr_pipe = child.stderr.take().unwrap();
    let run = async {
        let mut stderr = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut stderr).await;
        let status = child.wait().await;
        (status.map(|s| s.success()).unwrap_or(false), stderr)
    };
    let (ok, stderr) = match tokio::time::timeout(YT_TIMEOUT, run).await {
        Ok(r) => r,
        Err(_) => {
            let _ = child.kill().await;
            (false, b"timed out".to_vec())
        }
    };

    let file = format!("{}.{format}", job.id);
    if ok && job.dir.join(&file).exists() {
        let url = format!("{}/f/{file}", s.cfg.base_url);
        job.keep = Some(file);
        return Ok(Json(json!({ "url": url })));
    }
    let stderr = String::from_utf8_lossy(&stderr);
    let start = (stderr.len().saturating_sub(2000)..)
        .find(|&i| stderr.is_char_boundary(i))
        .unwrap_or(0);
    let tail = &stderr[start..];
    eprintln!("yt-dlp failed: {tail}");
    let too_big = stderr.to_lowercase().contains("larger than max-filesize");
    Err(ApiError::bad(if too_big {
        format!("Video exceeds {} MB limit", s.cfg.max_mb)
    } else {
        "Could not download that video".into()
    }))
}
