mod share;
mod youtube;

use std::{env, net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, State, multipart::Field},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::json;
use tokio::{fs, io::AsyncWriteExt};
use tower::ServiceBuilder;
use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer};

const ALLOWED: &[&str] = &[
    // audio
    ".mp3", ".wav", ".ogg", ".oga", ".flac", ".m4a", ".aac", ".opus", ".weba", // video
    ".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".ogv", // images
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp", ".ico",
];

/// Neutralises scripts inside uploaded SVGs / HTML.
pub const FILE_CSP: &str =
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'; sandbox";

pub struct Config {
    pub base_url: String,
    pub max_mb: u64,
    pub upload_dir: PathBuf,
    pub share_dir: PathBuf,
    pub yt_max_jobs: usize,
    pub yt_proxy: Option<String>,
}

impl Config {
    pub fn max_bytes(&self) -> u64 {
        self.max_mb * 1024 * 1024
    }
}

pub struct AppState {
    pub cfg: Config,
    pub yt: youtube::Jobs,
    pub shares: share::Store,
}

type AppStateRef = Arc<AppState>;

pub struct ApiError(pub StatusCode, pub String);

impl ApiError {
    pub fn bad(msg: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, msg.into())
    }
    pub fn internal() -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Something went wrong on the server".into(),
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<axum::extract::multipart::MultipartError> for ApiError {
    fn from(e: axum::extract::multipart::MultipartError) -> Self {
        Self(e.status(), e.body_text())
    }
}

pub fn random_id() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 6]>())
}

pub fn extension(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => name[i..].to_lowercase(),
        _ => String::new(),
    }
}

/// Streams a multipart field to `path`, enforcing `max` bytes. Removes the file on failure.
pub async fn save_field(field: &mut Field<'_>, path: &PathBuf, max: u64, max_mb: u64) -> Result<u64, ApiError> {
    let result = async {
        let mut out = fs::File::create(path).await.map_err(|_| ApiError::internal())?;
        let mut size = 0u64;
        while let Some(chunk) = field.chunk().await? {
            size += chunk.len() as u64;
            if size > max {
                return Err(ApiError(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    format!("File exceeds {max_mb} MB limit"),
                ));
            }
            out.write_all(&chunk).await.map_err(|_| ApiError::internal())?;
        }
        out.flush().await.map_err(|_| ApiError::internal())?;
        Ok(size)
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(path).await;
    }
    result
}

async fn config(State(s): State<AppStateRef>) -> Json<serde_json::Value> {
    Json(json!({
        "maxMb": s.cfg.max_mb,
        "extensions": ALLOWED,
        "shareTtls": share::TTLS.iter().map(|(k, _)| k).collect::<Vec<_>>(),
        "shareDefaultTtl": share::DEFAULT_TTL,
    }))
}

async fn upload(State(s): State<AppStateRef>, mut multipart: Multipart) -> Result<Json<serde_json::Value>, ApiError> {
    while let Some(mut field) = multipart.next_field().await? {
        if field.name() != Some("file") {
            continue;
        }
        let ext = extension(field.file_name().unwrap_or_default());
        if !ALLOWED.contains(&ext.as_str()) {
            let shown = if ext.is_empty() { "none" } else { &ext };
            return Err(ApiError::bad(format!("Unsupported file type: {shown}")));
        }
        let name = format!("{}{ext}", random_id());
        save_field(
            &mut field,
            &s.cfg.upload_dir.join(&name),
            s.cfg.max_bytes(),
            s.cfg.max_mb,
        )
        .await?;
        return Ok(Json(json!({ "url": format!("{}/f/{name}", s.cfg.base_url) })));
    }
    Err(ApiError::bad("No file provided"))
}

fn env_or<T: std::str::FromStr>(key: &str, default: T) -> T {
    env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// PID 1 in a container ignores SIGTERM unless handled.
async fn shutdown() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut term = signal(SignalKind::terminate()).expect("cannot listen for SIGTERM");
    tokio::select! {
        _ = term.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}

#[tokio::main]
async fn main() {
    let Ok(domain) = env::var("DOMAIN") else {
        eprintln!("DOMAIN environment variable is required (e.g. media.example.com)");
        std::process::exit(1);
    };
    let scheme = env::var("SCHEME").unwrap_or_else(|_| "https".into());
    let port: u16 = env_or("PORT", 3000);
    let cfg = Config {
        base_url: format!("{scheme}://{domain}"),
        max_mb: env_or("MAX_UPLOAD_MB", 500),
        upload_dir: env_or("UPLOAD_DIR", PathBuf::from("/data/uploads")),
        share_dir: env_or("SHARE_DIR", PathBuf::from("/data/shares")),
        yt_max_jobs: env_or("YT_MAX_JOBS", 2),
        yt_proxy: env::var("YT_PROXY").ok().filter(|v| !v.is_empty()),
    };
    let public_dir: PathBuf = env_or("PUBLIC_DIR", PathBuf::from("public"));
    std::fs::create_dir_all(&cfg.upload_dir).expect("cannot create UPLOAD_DIR");
    std::fs::create_dir_all(&cfg.share_dir).expect("cannot create SHARE_DIR");

    let body_limit = DefaultBodyLimit::max((cfg.max_bytes() + 1024 * 1024) as usize);
    let shares = share::Store::load(&cfg.share_dir).await;
    let state = Arc::new(AppState {
        cfg,
        yt: youtube::Jobs::default(),
        shares,
    });
    share::spawn_sweeper(state.clone());

    let files = ServiceBuilder::new()
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(FILE_CSP),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("*"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=2592000, immutable"),
        ))
        .service(ServeDir::new(&state.cfg.upload_dir));

    let app = Router::new()
        .route("/config", get(config))
        .route("/upload", post(upload).layer(body_limit))
        .route("/youtube", post(youtube::handler))
        .route("/share", post(share::create).layer(body_limit))
        .route("/share/{code}", get(share::info))
        .route("/s/{code}/file", get(share::file))
        .nest_service("/f", files)
        .fallback_service(ServeDir::new(public_dir))
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("cannot bind port");
    println!("Noecore MediaLinker on {} (port {port})", state.cfg.base_url);
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown())
        .await
        .unwrap();
}
