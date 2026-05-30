# Redis Client (TypeScript)

## Project Goal
Build a Redis client from scratch in TypeScript as a learning + CV project.
Implement the RESP2 protocol over raw TCP sockets, plus higher-level
patterns (rate limiting, distributed locking, message queue) on top.

Planned follow-up: rewrite in Rust or Go (decided later).

## Scope

**Protocol layer (built from scratch, no Redis libraries):**
- RESP2 parser (streaming, handles partial chunks)
- TCP connection management via Node's `net` module
- Core commands: GET, SET, DEL, EXPIRE, INCR, HGET, HSET
- Pipelining with request/response correlation
- Pub/sub with reconnection + resubscription
- Connection pooling with backpressure

**Patterns layer (built on top of our own client):**
- Distributed lock (Redlock-style, with fencing tokens)
- Rate limiter (token bucket or sliding window)
- Simple message queue

**Out of scope for v1:** RESP3, cluster mode, Sentinel, streams, Lua, modules.

## Tech Stack
- TypeScript (strict mode)
- Node.js 20+
- Vitest for testing
- Docker Compose to run Redis locally for integration tests
- No runtime dependencies in the protocol layer
- ESLint + Prettier for code style

## Conventions
- Explain architectural decisions before writing code.
- Test-driven where reasonable: write the test, then the implementation.
- Small, focused files. One concept per file.
- Prefer pure functions in the parser; isolate side effects in the client.
- Ask before adding any new dependency.
- Comments explain *why*, not *what*.
- Use descriptive names over short ones (e.g. `pendingResponses` not `pr`).

## Project Structure
```
src/
  protocol/    # RESP parser, serializer, types
  client/      # Connection, pool, pipelining, pub/sub
  patterns/    # Lock, rate limiter, queue
  index.ts
tests/
  protocol/
  client/
  patterns/
docker-compose.yml
```

## How I Learn Best
- I have parser experience, but TCP and sockets are new to me.
- When introducing a new concept (sockets, backpressure, framing, etc.),
  give a short conceptual explanation first, then the code.
- If I'm about to do something the wrong way, push back — don't just
  agree with me.
- Prefer one focused change at a time over big multi-file edits, so I
  can follow along and learn.

## Status
- [x] Project setup (TS, Vitest, Docker, ESLint, Prettier)
- [x] RESP2 parser (streaming) — all five types: simple, error, integer, bulk, array
- [ ] TCP connection + basic GET/SET
- [ ] Remaining core commands (DEL, EXPIRE, INCR, HGET, HSET)
- [ ] Pipelining
- [ ] Pub/sub with reconnection
- [ ] Connection pool
- [ ] Distributed lock (Redlock + fencing tokens)
- [ ] Rate limiter
- [ ] Message queue
- [ ] README + architecture write-up

## Notes
- The whole point of the protocol layer is to build it from scratch.
  Do NOT suggest using `ioredis`, `node-redis`, or any other Redis library
  in `src/protocol/` or `src/client/`. We are deliberately reinventing
  this wheel for educational reasons.
- v2 rewrite (Rust or Go) is a future project, not part of this repo.
