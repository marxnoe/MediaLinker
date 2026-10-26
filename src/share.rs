//! Temporary shares: any file or text, reachable through a short code until it expires.

use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json,
    body::Body,
    extract::{ConnectInfo, Multipart, Path as UrlPath, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use rand::seq::IndexedRandom;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::fs;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::{ApiError, AppStateRef, FILE_CSP, save_field};

/// No 0/O, 1/I/L, so codes survive being read out loud or typed from a screen.
const ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LEN: usize = 5;
pub const TTLS: &[(&str, u64)] = &[("1h", 3600), ("24h", 86_400), ("7d", 7 * 86_400)];
pub const DEFAULT_TTL: &str = "24h";
const MAX_TEXT_BYTES: usize = 1024 * 1024;
/// Failed code lookups allowed per client per window, to make guessing codes impractical.
const MAX_MISSES: u32 = 30;
const MISS_WINDOW: u64 = 10 * 60;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    code: String,
    kind: Kind,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime: Option<String>,
    size: u64,
    /// The browser or `ml` encrypted the content; the server holds ciphertext and never the key.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    encrypted: bool,
    created_at: u64,
    expires_at: u64,
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Text,
    File,
}

#[derive(Default)]
struct Inner {
    /// `None` while the upload for a reserved code is still in progress.
    shares: HashMap<String, Option<Meta>>,
    misses: HashMap<String, (u64, u32)>,
}

pub struct Store {
    dir: PathBuf,
    inner: Mutex<Inner>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn normalize(code: &str) -> Option<String> {
    let code = code.trim().to_ascii_uppercase();
    (code.len() == CODE_LEN && code.bytes().all(|b| ALPHABET.contains(&b))).then_some(code)
}

impl Store {
    fn meta_path(&self, code: &str) -> PathBuf {
        self.dir.join(format!("{code}.json"))
    }

    fn blob_path(&self, code: &str) -> PathBuf {
        self.dir.join(format!("{code}.bin"))
    }

    /// Loads shares that survived a restart and drops expired or orphaned files.
    pub async fn load(dir: &Path) -> Self {
        let store = Store {
            dir: dir.to_path_buf(),
            inner: Mutex::default(),
        };
        let mut shares = HashMap::new();
        let mut stale = Vec::new();
        if let Ok(mut entries) = fs::read_dir(dir).await {
            while let Ok(Some(e)) = entries.next_entry().await {
                let path = e.path();
                if path.extension().is_some_and(|x| x == "json") {
                    match fs::read(&path)
                        .await
                        .ok()
                        .and_then(|b| serde_json::from_slice::<Meta>(&b).ok())
                    {
                        Some(m) if m.expires_at > now() => {
                            shares.insert(m.code.clone(), Some(m));
                        }
                        _ => stale.push(path),
                    }
                }
            }
        }
        if let Ok(mut entries) = fs::read_dir(dir).await {
            while let Ok(Some(e)) = entries.next_entry().await {
                let path = e.path();
                let stem = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if path.extension().is_some_and(|x| x != "json") && !shares.contains_key(&stem) {
                    stale.push(path);
                }
            }
        }
        for path in stale {
            let _ = fs::remove_file(path).await;
        }
        println!("Loaded {} active shares", shares.len());
        store.inner.lock().unwrap().shares = shares;
        store
    }

    fn reserve(&self) -> String {
        let mut inner = self.inner.lock().unwrap();
        let mut rng = rand::rng();
        loop {
            let code: String = (0..CODE_LEN)
                .map(|_| *ALPHABET.choose(&mut rng).unwrap() as char)
                .collect();
            if !inner.shares.contains_key(&code) {
                inner.shares.insert(code.clone(), None);
                return code;
            }
        }
    }

    fn get(&self, code: &str) -> Option<Meta> {
        let inner = self.inner.lock().unwrap();
        inner.shares.get(code)?.clone().filter(|m| m.expires_at > now())
    }

    /// Counts a failed lookup; returns false once the client has used up its budget.
    fn allow_lookup(&self, client: &str) -> bool {
        let inner = self.inner.lock().unwrap();
        inner
            .misses
            .get(client)
            .is_none_or(|&(start, n)| start + MISS_WINDOW < now() || n < MAX_MISSES)
    }

    fn record_miss(&self, client: &str) {
        let mut inner = self.inner.lock().unwrap();
        let t = now();
        let entry = inner.misses.entry(client.to_string()).or_insert((t, 0));
        if entry.0 + MISS_WINDOW < t {
            *entry = (t, 0);
        }
        entry.1 += 1;
    }

    async fn remove_files(&self, code: &str) {
        let _ = fs::remove_file(self.meta_path(code)).await;
        let _ = fs::remove_file(self.blob_path(code)).await;
    }

    async fn sweep(&self) {
        let t = now();
        let expired: Vec<String> = {
            let mut inner = self.inner.lock().unwrap();
            inner.misses.retain(|_, (start, _)| *start + MISS_WINDOW >= t);
            let expired = inner
                .shares
                .iter()
                .filter(|(_, m)| m.as_ref().is_some_and(|m| m.expires_at <= t))
                .map(|(c, _)| c.clone())
                .collect();
            for code in &expired {
                inner.shares.remove(code);
            }
            expired
        };
        for code in expired {
            self.remove_files(&code).await;
        }
    }
}

pub fn spawn_sweeper(state: AppStateRef) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            state.shares.sweep().await;
        }
    });
}

/// Frees a reserved code and its files unless the upload completed (also on client disconnect).
struct Reservation<'a> {
    store: &'a Store,
    code: String,
    done: bool,
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        if !self.done {
            self.store.inner.lock().unwrap().shares.remove(&self.code);
            let _ = std::fs::remove_file(self.store.blob_path(&self.code));
            let _ = std::fs::remove_file(self.store.meta_path(&self.code));
        }
    }
}

#[derive(Deserialize)]
pub struct CreateQuery {
    ttl: Option<String>,
    encrypted: Option<String>,
}

pub async fn create(
    State(s): State<AppStateRef>,
    Query(q): Query<CreateQuery>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ttl_key = q.ttl.as_deref().unwrap_or(DEFAULT_TTL);
    let &(_, ttl) = TTLS
        .iter()
        .find(|(k, _)| *k == ttl_key)
        .ok_or_else(|| ApiError::bad("Unknown expiry"))?;
    let encrypted = matches!(q.encrypted.as_deref(), Some("1" | "true"));

    while let Some(mut field) = multipart.next_field().await? {
        let kind = match field.name() {
            Some("file") => Kind::File,
            Some("text") => Kind::Text,
            _ => continue,
        };
        if encrypted && kind == Kind::Text {
            return Err(ApiError::bad("Encrypted shares are sent as a file"));
        }
        let mut res = Reservation {
            store: &s.shares,
            code: s.shares.reserve(),
            done: false,
        };
        let created_at = now();
        let mut meta = Meta {
            code: res.code.clone(),
            kind,
            text: None,
            name: None,
            mime: None,
            size: 0,
            encrypted,
            created_at,
            expires_at: created_at + ttl,
        };
        if kind == Kind::File {
            // The real name and type of an encrypted share are inside the ciphertext.
            let name = if encrypted {
                "encrypted.bin".into()
            } else {
                clean_name(field.file_name().unwrap_or_default())
            };
            meta.mime = Some(
                mime_guess::from_path(&name)
                    .first_or_octet_stream()
                    .essence_str()
                    .to_string(),
            );
            meta.size = save_field(
                &mut field,
                &s.shares.blob_path(&res.code),
                s.cfg.max_bytes(),
                s.cfg.max_mb,
            )
            .await?;
            meta.name = Some(name);
        } else {
            let mut buf = Vec::new();
            while let Some(chunk) = field.chunk().await? {
                buf.extend_from_slice(&chunk);
                if buf.len() > MAX_TEXT_BYTES {
                    return Err(ApiError(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "Text exceeds 1 MB limit".into(),
                    ));
                }
            }
            // Browsers send textarea line breaks as CRLF.
            let text = String::from_utf8(buf)
                .map_err(|_| ApiError::bad("Text must be UTF-8"))?
                .replace("\r\n", "\n");
            if text.trim().is_empty() {
                return Err(ApiError::bad("Text is empty"));
            }
            meta.size = text.len() as u64;
            meta.text = Some(text);
        }

        let tmp = s.shares.dir.join(format!("{}.json.tmp", res.code));
        let bytes = serde_json::to_vec(&meta).map_err(|_| ApiError::internal())?;
        fs::write(&tmp, bytes).await.map_err(|_| ApiError::internal())?;
        fs::rename(&tmp, s.shares.meta_path(&res.code))
            .await
            .map_err(|_| ApiError::internal())?;
        s.shares
            .inner
            .lock()
            .unwrap()
            .shares
            .insert(res.code.clone(), Some(meta.clone()));
        res.done = true;
        return Ok(Json(json!({ "code": meta.code, "expiresAt": meta.expires_at * 1000 })));
    }
    Err(ApiError::bad("Nothing to share: send a file or some text"))
}

/// Keeps the original name for downloads, minus path parts and control characters.
fn clean_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or_default();
    let name: String = base.chars().filter(|c| !c.is_control()).take(200).collect();
    if name.trim().is_empty() { "file".into() } else { name }
}

fn client_key(headers: &HeaderMap, addr: SocketAddr) -> String {
    // Behind Traefik, like the old `trust proxy` setting.
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| addr.ip().to_string())
}

fn lookup(s: &AppStateRef, code: &str, headers: &HeaderMap, addr: SocketAddr) -> Result<Meta, ApiError> {
    let client = client_key(headers, addr);
    if !s.shares.allow_lookup(&client) {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many wrong codes, try again in a few minutes".into(),
        ));
    }
    match normalize(code).and_then(|c| s.shares.get(&c)) {
        Some(m) => Ok(m),
        None => {
            s.shares.record_miss(&client);
            Err(ApiError(
                StatusCode::NOT_FOUND,
                "No share with that code (it may have expired)".into(),
            ))
        }
    }
}

pub async fn info(
    State(s): State<AppStateRef>,
    UrlPath(code): UrlPath<String>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let meta = lookup(&s, &code, &headers, addr)?;
    let mut body = serde_json::to_value(&meta).map_err(|_| ApiError::internal())?;
    body["expiresAt"] = json!(meta.expires_at * 1000);
    body["createdAt"] = json!(meta.created_at * 1000);
    if meta.kind == Kind::File {
        body["url"] = json!(format!("/s/{}/file", meta.code));
    }
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(body)).into_response())
}

#[derive(Deserialize)]
pub struct FileQuery {
    download: Option<String>,
}

pub async fn file(
    State(s): State<AppStateRef>,
    UrlPath(code): UrlPath<String>,
    Query(q): Query<FileQuery>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Result<Response, ApiError> {
    let meta = lookup(&s, &code, req.headers(), addr)?;
    if meta.kind != Kind::File {
        return Err(ApiError(StatusCode::NOT_FOUND, "This share is text, not a file".into()));
    }
    let mime = meta.mime.clone().unwrap_or_else(|| "application/octet-stream".into());
    let mime_value: mime_guess::Mime = mime.parse().unwrap_or(mime_guess::mime::APPLICATION_OCTET_STREAM);
    let mut res = ServeFile::new_with_mime(s.shares.blob_path(&meta.code), &mime_value)
        .oneshot(req)
        .await
        .map_err(|_| ApiError::internal())?
        .map(Body::new);

    let media = ["image/", "audio/", "video/"].iter().any(|p| mime.starts_with(p));
    let disposition = if media && q.download.is_none() {
        "inline"
    } else {
        "attachment"
    };
    let name = meta.name.unwrap_or_else(|| "file".into());
    let ascii: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let value = format!(
        "{disposition}; filename=\"{ascii}\"; filename*=UTF-8''{}",
        percent_encode(&name)
    );
    let h = res.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&value) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(FILE_CSP));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=300"));
    Ok(res)
}

fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_case_insensitive_and_validated() {
        assert_eq!(normalize(" k7qx2 ").as_deref(), Some("K7QX2"));
        assert_eq!(normalize("K7QX"), None);
        assert_eq!(normalize("K7QX0"), None);
        assert_eq!(normalize("../..").as_deref(), None);
    }

    #[test]
    fn names_lose_paths() {
        assert_eq!(clean_name("C:\\Users\\x\\report.pdf"), "report.pdf");
        assert_eq!(clean_name("../../etc/passwd"), "passwd");
        assert_eq!(clean_name(""), "file");
    }
}
