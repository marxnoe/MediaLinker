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
RUN adduser -D -u 1000 app
WORKDIR /app
COPY --from=backend /build/target/release/medialinker ./
COPY --from=frontend /build/dist/frontend/browser ./public
RUN mkdir -p /data/uploads /data/shares /data/clips && chown -R app:app /data /app
USER app
EXPOSE 3000
CMD ["./medialinker"]
