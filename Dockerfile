FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npx ng build --configuration production

FROM rust:1-alpine AS backend
RUN apk add --no-cache musl-dev
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM alpine:3
# nodejs is only yt-dlp's JavaScript runtime (--js-runtimes node).
RUN apk add --no-cache python3 ffmpeg nodejs ca-certificates \
 && adduser -D -u 1000 app \
 && wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
 && chmod 755 /usr/local/bin/yt-dlp && chown app:app /usr/local/bin/yt-dlp
WORKDIR /app
COPY --from=backend /build/target/release/medialinker ./
COPY --from=frontend /build/dist/frontend/browser ./public
RUN mkdir -p /data/uploads /data/shares && chown -R app:app /data /app
USER app
EXPOSE 3000
# yt-dlp breaks often as YouTube changes; self-update on start (best effort)
CMD ["sh", "-c", "yt-dlp -U >/dev/null 2>&1 || true; exec ./medialinker"]
