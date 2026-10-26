//! Shared clipboard: rooms of paired devices that relay end-to-end encrypted clips.
//!
//! The server never sees a room key. Devices derive the room ID from it, announce every copy as
//! encrypted metadata over a WebSocket, and upload images and files as encrypted blobs that the other
//! devices can stream while the upload is still running. The newest clip wins: clips are ordered by
//! the time they were copied (on the server's clock), ties broken by ID, and anything older than the
//! room's latest clip is turned away, so every device ends up with the same clipboard.
//!
//! Pairing codes look like `K7X-42PQ`. The server hands out the public first half, the "plate", and
//! relays a PAKE exchange between the two devices that only the secret second half can complete, so
//! it learns neither the code nor the room key.

use std::{
    collections::{HashMap, VecDeque},
    io,
    net::SocketAddr,
    path::{Path, PathBuf},
    pin::pin,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    Json,
    body::{Body, Bytes},
    extract::{
        ConnectInfo, Path as UrlPath, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use rand::seq::IndexedRandom;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::{
    fs::{self, File},
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::{broadcast, mpsc, oneshot, watch},
};

use crate::{ApiError, AppStateRef, share};

/// Room and clip IDs are 16 bytes in base64url.
const ID_LEN: usize = 22;
const PLATE_LEN: usize = 3;
const MAX_SLOTS: usize = 10_000;
/// Encrypted metadata, which carries short text inline.
const MAX_META: usize = 256 * 1024;
/// Blobs kept per room: the latest clip's and a couple before it, for devices still downloading those.
const KEEP_BLOBS: usize = 3;
const ROOM_TTL: u64 = 30 * 86_400;
const PING_EVERY: Duration = Duration::from_secs(20);
/// A device that hasn't answered for this long is gone (asleep, or its network vanished).
const DEAD_AFTER: Duration = Duration::from_secs(60);
/// How long a download waits for a stalled upload before giving up.
const STALL: Duration = Duration::from_secs(120);
const PAIR_TTL: Duration = Duration::from_secs(10 * 60);
const PAIR_TALK: Duration = Duration::from_secs(60);
const PAIR_MESSAGES: usize = 8;

#[derive(Clone, Serialize, Deserialize)]
pub struct Clip {
    seq: u64,
    id: String,
    /// When it was copied, in milliseconds on the server's clock.
    at: u64,
    /// Base64url ciphertext of the clip's metadata.
    meta: String,
    /// Whether the content follows as a blob (images, files, long text).
    blob: bool,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Upload {
    Waiting,
    Running,
    Done,
    Failed,
}

#[derive(Clone, Copy)]
struct BlobState {
    status: Upload,
    written: u64,
    /// Bumped on every upload attempt, so a download can't stitch two attempts together.
    attempt: u32,
}

struct Blob {
    id: String,
    state: Arc<watch::Sender<BlobState>>,
}

impl Blob {
    fn new(id: String, status: Upload, written: u64) -> Self {
        let (state, _) = watch::channel(BlobState {
            status,
            written,
            attempt: 0,
        });
        Self {
            id,
            state: Arc::new(state),
        }
    }
}

struct Room {
    latest: Option<Clip>,
    seq: u64,
    /// Oldest first.
    blobs: VecDeque<Blob>,
    tx: broadcast::Sender<Arc<str>>,
    devices: usize,
    active: u64,
}

impl Room {
    fn new() -> Self {
        Self {
            latest: None,
            seq: 0,
            blobs: VecDeque::new(),
            tx: broadcast::channel(64).0,
            devices: 0,
            active: now(),
        }
    }
}

struct Slot {
    to_host: mpsc::Sender<String>,
    joined: oneshot::Sender<mpsc::Sender<String>>,
}

pub struct Clips {
    dir: PathBuf,
    max_bytes: u64,
    rooms: Mutex<HashMap<String, Room>>,
    slots: Mutex<HashMap<String, Slot>>,
}

fn now() -> u64 {
    now_ms() / 1000
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn valid_id(id: &str) -> bool {
    id.len() == ID_LEN && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn normalize_plate(plate: &str) -> Option<String> {
    let plate = plate.trim().to_ascii_uppercase();
    (plate.len() == PLATE_LEN && plate.bytes().all(|b| share::ALPHABET.contains(&b))).then_some(plate)
}

impl Clips {
    fn room_dir(&self, room: &str) -> PathBuf {
        self.dir.join(room)
    }

    fn blob_path(&self, room: &str, id: &str) -> PathBuf {
        self.room_dir(room).join(format!("{id}.bin"))
    }

    /// Restores each room's latest clip after a restart and drops idle rooms and stray files.
    pub async fn load(dir: &Path, max_bytes: u64) -> Self {
        let mut rooms = HashMap::new();
        if let Ok(mut entries) = fs::read_dir(dir).await {
            while let Ok(Some(e)) = entries.next_entry().await {
                let path = e.path();
                let name = e.file_name().to_string_lossy().into_owned();
                let clip = fs::read(path.join("latest.json"))
                    .await
                    .ok()
                    .and_then(|b| serde_json::from_slice::<Clip>(&b).ok());
                let Some(clip) = clip.filter(|c| valid_id(&name) && c.at / 1000 + ROOM_TTL > now()) else {
                    let _ = fs::remove_dir_all(&path).await;
                    continue;
                };
                let mut room = Room::new();
                room.seq = clip.seq;
                room.active = clip.at / 1000;
                let mut keep = vec!["latest.json".to_string()];
                if clip.blob {
                    // Only a finished upload has its `.ok` marker; anything else was cut off by the restart.
                    let done = fs::read_to_string(path.join(format!("{}.ok", clip.id)))
                        .await
                        .ok()
                        .and_then(|s| s.trim().parse::<u64>().ok());
                    let blob = match done {
                        Some(size) => Blob::new(clip.id.clone(), Upload::Done, size),
                        None => Blob::new(clip.id.clone(), Upload::Failed, 0),
                    };
                    room.blobs.push_back(blob);
                    keep.push(format!("{}.bin", clip.id));
                    keep.push(format!("{}.ok", clip.id));
                }
                if let Ok(mut files) = fs::read_dir(&path).await {
                    while let Ok(Some(f)) = files.next_entry().await {
                        if !keep.contains(&f.file_name().to_string_lossy().into_owned()) {
                            let _ = fs::remove_file(f.path()).await;
                        }
                    }
                }
                room.latest = Some(clip);
                rooms.insert(name, room);
            }
        }
        println!("Loaded {} clipboard rooms", rooms.len());
        Self {
            dir: dir.to_path_buf(),
            max_bytes,
            rooms: Mutex::new(rooms),
            slots: Mutex::default(),
        }
    }

    /// Adds a device to a room; returns its greeting and its feed of the room's messages.
    fn join(&self, room: &str) -> (String, broadcast::Receiver<Arc<str>>) {
        let mut rooms = self.rooms.lock().unwrap();
        let r = rooms.entry(room.to_string()).or_insert_with(Room::new);
        r.devices += 1;
        r.active = now();
        let rx = r.tx.subscribe();
        let _ = r.tx.send(json!({ "t": "devices", "n": r.devices }).to_string().into());
        let hello = json!({ "t": "hello", "now": now_ms(), "clip": r.latest, "devices": r.devices });
        (hello.to_string(), rx)
    }

    fn leave(&self, room: &str) {
        let mut rooms = self.rooms.lock().unwrap();
        if let Some(r) = rooms.get_mut(room) {
            r.devices -= 1;
            r.active = now();
            let _ = r.tx.send(json!({ "t": "devices", "n": r.devices }).to_string().into());
        }
    }

    /// Handles one message from a device; returns a reply for that device alone, if any.
    fn handle(&self, room: &str, text: &str) -> Option<String> {
        let msg = match serde_json::from_str::<Incoming>(text) {
            Ok(m) => m,
            Err(_) => return Some(error("Unknown message")),
        };
        let Incoming::Clip { id, at, meta, blob } = msg else {
            return Some(json!({ "t": "pong", "now": now_ms() }).to_string());
        };
        if !valid_id(&id) || meta.is_empty() || meta.len() > MAX_META {
            return Some(error("Malformed clip"));
        }
        let mut rooms = self.rooms.lock().unwrap();
        let r = rooms.get_mut(room)?;
        // A clock running ahead mustn't let a device win every race from now on.
        let at = at.min(now_ms());
        if let Some(l) = &r.latest
            && (at, id.as_str()) <= (l.at, l.id.as_str())
        {
            return Some(json!({ "t": "stale", "id": id, "clip": l }).to_string());
        }
        r.seq += 1;
        r.active = now();
        let clip = Clip {
            seq: r.seq,
            id,
            at,
            meta,
            blob,
        };
        let mut pruned = Vec::new();
        if blob {
            r.blobs.push_back(Blob::new(clip.id.clone(), Upload::Waiting, 0));
            while r.blobs.len() > KEEP_BLOBS {
                pruned.extend(r.blobs.pop_front().map(|b| b.id));
            }
        }
        r.latest = Some(clip.clone());
        let _ = r.tx.send(json!({ "t": "clip", "clip": clip }).to_string().into());

        // Small and rare (one write per copy), so it's written in place to keep restarts in order.
        let dir = self.room_dir(room);
        let saved = std::fs::create_dir_all(&dir).and_then(|_| {
            let tmp = dir.join("latest.json.tmp");
            std::fs::write(&tmp, serde_json::to_vec(&clip).unwrap_or_default())?;
            std::fs::rename(tmp, dir.join("latest.json"))
        });
        if let Err(e) = saved {
            eprintln!("cannot save clipboard room {room}: {e}");
        }
        for id in pruned {
            let _ = std::fs::remove_file(dir.join(format!("{id}.bin")));
            let _ = std::fs::remove_file(dir.join(format!("{id}.ok")));
        }
        None
    }

    fn blob(&self, room: &str, id: &str) -> Option<Arc<watch::Sender<BlobState>>> {
        let rooms = self.rooms.lock().unwrap();
        let r = rooms.get(room)?;
        r.blobs.iter().find(|b| b.id == id).map(|b| b.state.clone())
    }

    fn add_slot(&self, slot: Slot) -> Option<String> {
        let mut slots = self.slots.lock().unwrap();
        if slots.len() >= MAX_SLOTS {
            return None;
        }
        let mut rng = rand::rng();
        loop {
            let plate: String = (0..PLATE_LEN)
                .map(|_| *share::ALPHABET.choose(&mut rng).unwrap() as char)
                .collect();
            if !slots.contains_key(&plate) {
                slots.insert(plate.clone(), slot);
                return Some(plate);
            }
        }
    }

    async fn sweep(&self) {
        let t = now();
        let idle: Vec<String> = {
            let mut rooms = self.rooms.lock().unwrap();
            let idle: Vec<String> = rooms
                .iter()
                .filter(|(_, r)| r.devices == 0 && r.active + ROOM_TTL < t)
                .map(|(k, _)| k.clone())
                .collect();
            for k in &idle {
                rooms.remove(k);
            }
            // Rooms nobody ever copied into have nothing on disk and can go as soon as they're empty.
            rooms.retain(|_, r| r.devices > 0 || r.latest.is_some());
            idle
        };
        for room in idle {
            let _ = fs::remove_dir_all(self.room_dir(&room)).await;
        }
    }
}

pub fn spawn_sweeper(state: AppStateRef) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(600));
        loop {
            tick.tick().await;
            state.clips.sweep().await;
        }
    });
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum Incoming {
    Ping,
    Clip {
        id: String,
        at: u64,
        meta: String,
        #[serde(default)]
        blob: bool,
    },
}

fn error(msg: &str) -> String {
    json!({ "t": "error", "error": msg }).to_string()
}

#[derive(Deserialize)]
pub struct RoomQuery {
    room: String,
}

pub async fn ws(
    State(s): State<AppStateRef>,
    Query(q): Query<RoomQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    if !valid_id(&q.room) {
        return Err(ApiError::bad("Not a clipboard room"));
    }
    Ok(ws
        .max_message_size(MAX_META + 4096)
        .on_upgrade(move |socket| room_socket(s, q.room, socket)))
}

async fn room_socket(s: AppStateRef, room: String, socket: WebSocket) {
    let (hello, mut feed) = s.clips.join(&room);
    let (mut sink, mut stream) = socket.split();
    let mut ping = tokio::time::interval(PING_EVERY);
    let mut seen = Instant::now();
    if sink.send(Message::Text(hello.into())).await.is_ok() {
        loop {
            tokio::select! {
                msg = stream.next() => match msg {
                    Some(Ok(Message::Text(t))) => {
                        seen = Instant::now();
                        if let Some(reply) = s.clips.handle(&room, &t)
                            && sink.send(Message::Text(reply.into())).await.is_err()
                        {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => seen = Instant::now(),
                },
                out = feed.recv() => match out {
                    Ok(text) => {
                        if sink.send(Message::Text(text.as_ref().into())).await.is_err() {
                            break;
                        }
                    }
                    // Too far behind: drop it, and the device catches up from the greeting when it reconnects.
                    Err(_) => break,
                },
                _ = ping.tick() => {
                    if seen.elapsed() > DEAD_AFTER || sink.send(Message::Ping(Bytes::new())).await.is_err() {
                        break;
                    }
                }
            }
        }
    }
    s.clips.leave(&room);
}

/// Marks an upload failed unless it finished, also when the uploader disconnects mid-way.
struct UploadGuard {
    state: Arc<watch::Sender<BlobState>>,
    done: bool,
}

impl Drop for UploadGuard {
    fn drop(&mut self) {
        if !self.done {
            self.state.send_modify(|b| b.status = Upload::Failed);
        }
    }
}

pub async fn put_blob(
    State(s): State<AppStateRef>,
    UrlPath((room, id)): UrlPath<(String, String)>,
    body: Body,
) -> Result<Json<serde_json::Value>, ApiError> {
    let state = s
        .clips
        .blob(&room, &id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "No such clip (a newer one replaced it)".into()))?;
    let mut claimed = false;
    state.send_if_modified(|b| {
        claimed = matches!(b.status, Upload::Waiting | Upload::Failed);
        if claimed {
            *b = BlobState {
                status: Upload::Running,
                written: 0,
                attempt: b.attempt + 1,
            };
        }
        claimed
    });
    if !claimed {
        let b = *state.borrow();
        return match b.status {
            Upload::Done => Ok(Json(json!({ "size": b.written }))),
            _ => Err(ApiError(
                StatusCode::CONFLICT,
                "This clip is already being uploaded".into(),
            )),
        };
    }
    let mut guard = UploadGuard {
        state: state.clone(),
        done: false,
    };
    let path = s.clips.blob_path(&room, &id);
    let max = s.clips.max_bytes;
    let size = async {
        fs::create_dir_all(path.parent().unwrap())
            .await
            .map_err(|_| ApiError::internal())?;
        let mut out = File::create(&path).await.map_err(|_| ApiError::internal())?;
        let mut stream = body.into_data_stream();
        let mut size = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| ApiError::bad("Upload interrupted"))?;
            size += chunk.len() as u64;
            if size > max {
                return Err(ApiError(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    format!("Clips are limited to {} MB", max / 1024 / 1024),
                ));
            }
            out.write_all(&chunk).await.map_err(|_| ApiError::internal())?;
            // Downloads read the file as it grows, so each chunk has to reach it before it's announced.
            out.flush().await.map_err(|_| ApiError::internal())?;
            state.send_modify(|b| b.written = size);
        }
        out.sync_all().await.map_err(|_| ApiError::internal())?;
        fs::write(path.with_extension("ok"), size.to_string())
            .await
            .map_err(|_| ApiError::internal())?;
        Ok(size)
    }
    .await?;
    guard.done = true;
    state.send_modify(|b| b.status = Upload::Done);
    Ok(Json(json!({ "size": size })))
}

/// Streams a blob from disk, following an upload that is still running until it finishes.
struct Follow {
    state: watch::Receiver<BlobState>,
    path: PathBuf,
    file: Option<File>,
    pos: u64,
    attempt: Option<u32>,
}

impl Follow {
    async fn next_chunk(&mut self) -> Option<io::Result<Bytes>> {
        loop {
            let b = *self.state.borrow_and_update();
            match (b.status, self.attempt) {
                (Upload::Waiting | Upload::Failed, None) => {}
                (Upload::Failed, Some(_)) => return Some(Err(io::Error::other("the upload failed"))),
                (Upload::Waiting, Some(_)) => return Some(Err(io::Error::other("the upload restarted"))),
                (Upload::Running | Upload::Done, _) => {
                    if self.attempt.is_some_and(|a| a != b.attempt) {
                        return Some(Err(io::Error::other("the upload restarted")));
                    }
                    self.attempt = Some(b.attempt);
                    if self.pos < b.written {
                        return Some(self.read(b.written).await);
                    }
                    if b.status == Upload::Done {
                        return None;
                    }
                }
            }
            match tokio::time::timeout(STALL, self.state.changed()).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => return Some(Err(io::Error::other("a newer clip replaced this one"))),
                Err(_) => return Some(Err(io::Error::other("the upload stalled"))),
            }
        }
    }

    async fn read(&mut self, written: u64) -> io::Result<Bytes> {
        if self.file.is_none() {
            let mut f = File::open(&self.path).await?;
            f.seek(io::SeekFrom::Start(self.pos)).await?;
            self.file = Some(f);
        }
        let want = (written - self.pos).min(256 * 1024) as usize;
        let mut buf = vec![0; want];
        let n = self.file.as_mut().unwrap().read(&mut buf).await?;
        if n == 0 {
            return Err(io::Error::other("the upload was cut short"));
        }
        buf.truncate(n);
        self.pos += n as u64;
        Ok(buf.into())
    }
}

pub async fn get_blob(
    State(s): State<AppStateRef>,
    UrlPath((room, id)): UrlPath<(String, String)>,
) -> Result<Response, ApiError> {
    let state = s
        .clips
        .blob(&room, &id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "No such clip (a newer one replaced it)".into()))?;
    let b = *state.borrow();
    let follow = Follow {
        state: state.subscribe(),
        path: s.clips.blob_path(&room, &id),
        file: None,
        pos: 0,
        attempt: None,
    };
    let stream = futures_util::stream::unfold(follow, |mut f| async move { f.next_chunk().await.map(|c| (c, f)) });
    let mut res = (
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Body::from_stream(stream),
    )
        .into_response();
    // The length is only known up front once the upload is done.
    if b.status == Upload::Done {
        res.headers_mut().insert(header::CONTENT_LENGTH, b.written.into());
    }
    Ok(res)
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum PairHello {
    Host,
    Join { plate: String },
}

#[derive(Deserialize)]
struct Relayed {
    t: String,
    data: String,
}

pub async fn pair(
    State(s): State<AppStateRef>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let client = share::client_key(&headers, addr);
    ws.max_message_size(64 * 1024)
        .on_upgrade(move |socket| pair_socket(s, client, socket))
}

async fn pair_socket(s: AppStateRef, client: String, mut socket: WebSocket) {
    let first = match tokio::time::timeout(Duration::from_secs(30), socket.recv()).await {
        Ok(Some(Ok(Message::Text(t)))) => t,
        _ => return,
    };
    match serde_json::from_str::<PairHello>(&first) {
        Ok(PairHello::Host) => host(s, socket).await,
        Ok(PairHello::Join { plate }) => join(s, client, plate, socket).await,
        Err(_) => {
            let _ = socket.send(Message::Text(error("Unknown message").into())).await;
        }
    }
}

/// Only `{"t":"msg","data":...}` passes between the devices, and only a few of them.
fn relayable(text: &str) -> bool {
    serde_json::from_str::<Relayed>(text).is_ok_and(|m| m.t == "msg" && m.data.len() <= 16 * 1024)
}

async fn host(s: AppStateRef, mut socket: WebSocket) {
    let (to_host, mut inbox) = mpsc::channel::<String>(PAIR_MESSAGES * 2);
    let (joined, mut joined_rx) = oneshot::channel();
    let Some(plate) = s.clips.add_slot(Slot { to_host, joined }) else {
        let _ = socket
            .send(Message::Text(
                error("Too many pairings right now, try again in a minute").into(),
            ))
            .await;
        return;
    };
    let hello = json!({ "t": "plate", "plate": plate, "expiresAt": now_ms() + PAIR_TTL.as_millis() as u64 });
    let mut deadline = pin!(tokio::time::sleep(PAIR_TTL));
    let mut peer: Option<mpsc::Sender<String>> = None;
    let mut sent = 0;
    if socket.send(Message::Text(hello.to_string().into())).await.is_ok() {
        loop {
            tokio::select! {
                _ = &mut deadline => {
                    let msg = if peer.is_some() { "Pairing took too long" } else { "This pairing code expired" };
                    let _ = socket.send(Message::Text(error(msg).into())).await;
                    break;
                }
                j = &mut joined_rx, if peer.is_none() => match j {
                    Ok(tx) => {
                        peer = Some(tx);
                        deadline.as_mut().reset(tokio::time::Instant::now() + PAIR_TALK);
                    }
                    Err(_) => break,
                },
                m = inbox.recv() => match m {
                    Some(t) => if socket.send(Message::Text(t.into())).await.is_err() { break },
                    None => break,
                },
                m = socket.recv() => match m {
                    Some(Ok(Message::Text(t))) => {
                        if let Some(p) = &peer && relayable(&t) && sent < PAIR_MESSAGES {
                            sent += 1;
                            let _ = p.send(t.to_string()).await;
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                },
            }
        }
    }
    s.clips.slots.lock().unwrap().remove(&plate);
}

async fn join(s: AppStateRef, client: String, plate: String, mut socket: WebSocket) {
    if !s.shares.allow_lookup(&client) {
        let msg = error("Too many wrong codes, try again in a few minutes");
        let _ = socket.send(Message::Text(msg.into())).await;
        return;
    }
    let slot = normalize_plate(&plate).and_then(|p| s.clips.slots.lock().unwrap().remove(&p));
    let Some(slot) = slot else {
        s.shares.record_miss(&client);
        let msg = error("No pairing with that code (it may have expired or been used already)");
        let _ = socket.send(Message::Text(msg.into())).await;
        return;
    };
    let (to_me, mut inbox) = mpsc::channel::<String>(PAIR_MESSAGES * 2);
    if slot.joined.send(to_me).is_err() {
        let _ = socket.send(Message::Text(error("The other device left").into())).await;
        return;
    }
    let sid = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 16]>());
    let start = json!({ "t": "start", "sid": sid }).to_string();
    if slot.to_host.send(start.clone()).await.is_err() || socket.send(Message::Text(start.into())).await.is_err() {
        return;
    }
    let mut deadline = pin!(tokio::time::sleep(PAIR_TALK));
    let mut sent = 0;
    loop {
        tokio::select! {
            _ = &mut deadline => {
                let _ = socket.send(Message::Text(error("Pairing took too long").into())).await;
                break;
            }
            m = inbox.recv() => match m {
                Some(t) => if socket.send(Message::Text(t.into())).await.is_err() { break },
                None => break,
            },
            m = socket.recv() => match m {
                Some(Ok(Message::Text(t))) => {
                    if relayable(&t) && sent < PAIR_MESSAGES {
                        sent += 1;
                        let _ = slot.to_host.send(t.to_string()).await;
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clips() -> Clips {
        Clips {
            dir: std::env::temp_dir().join(format!("ml-clip-test-{}", rand::random::<u32>())),
            max_bytes: 1024,
            rooms: Mutex::default(),
            slots: Mutex::default(),
        }
    }

    fn clip_msg(id: &str, at: u64) -> String {
        json!({ "t": "clip", "id": id, "at": at, "meta": "x", "blob": true }).to_string()
    }

    #[test]
    fn ids_and_plates_are_validated() {
        assert!(valid_id("AAAAAAAAAAAAAAAAAAAAA-"));
        assert!(!valid_id("../AAAAAAAAAAAAAAAAAAAA"));
        assert!(!valid_id("short"));
        assert_eq!(normalize_plate(" k7x ").as_deref(), Some("K7X"));
        assert_eq!(normalize_plate("K0X"), None);
    }

    #[test]
    fn newest_clip_wins_and_older_ones_are_turned_away() {
        let c = clips();
        let room = "R".repeat(ID_LEN);
        let (_, mut feed) = c.join(&room);
        let t = now_ms() - 10_000;
        let a = "a".repeat(ID_LEN);
        let b = "b".repeat(ID_LEN);
        assert!(c.handle(&room, &clip_msg(&b, t)).is_none());
        // Same moment: the larger ID wins, so every device agrees.
        let stale = c.handle(&room, &clip_msg(&a, t)).unwrap();
        assert!(stale.contains("\"stale\""));
        // A copy from later wins even if it arrives after.
        assert!(c.handle(&room, &clip_msg(&a, t + 1)).is_none());
        // Clocks ahead of the server are pulled back to now.
        assert!(c.handle(&room, &clip_msg(&b, u64::MAX)).is_none());
        let latest = c.rooms.lock().unwrap()[&room].latest.clone().unwrap();
        assert!(latest.at <= now_ms() && latest.seq == 3);

        let mut seen = Vec::new();
        while let Ok(m) = feed.try_recv() {
            seen.push(m.to_string());
        }
        assert_eq!(seen.iter().filter(|m| m.contains("\"t\":\"clip\"")).count(), 3);
        let _ = std::fs::remove_dir_all(&c.dir);
    }

    #[test]
    fn only_the_newest_blobs_are_kept() {
        let c = clips();
        let room = "R".repeat(ID_LEN);
        let _feed = c.join(&room);
        let ids: Vec<String> = (0..5).map(|i| format!("{i}").repeat(ID_LEN)).collect();
        for (i, id) in ids.iter().enumerate() {
            c.handle(&room, &clip_msg(id, 1000 + i as u64));
        }
        assert!(c.blob(&room, &ids[0]).is_none());
        assert!(c.blob(&room, &ids[4]).is_some());
        assert_eq!(c.rooms.lock().unwrap()[&room].blobs.len(), KEEP_BLOBS);
        let _ = std::fs::remove_dir_all(&c.dir);
    }

    #[test]
    fn only_pairing_messages_are_relayed() {
        assert!(relayable(r#"{"t":"msg","data":"abc"}"#));
        assert!(!relayable(r#"{"t":"clip","data":"abc"}"#));
        assert!(!relayable("nope"));
    }
}
