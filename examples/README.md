# Demo: rate-limited job intake + reliable worker

End-to-end demo of the patterns layer. Three terminals.

## Setup

```bash
# Terminal 0 — Redis
docker compose up -d
```

## Run

```bash
# Terminal 1 — HTTP server (per-IP rate limit, enqueues jobs)
npx tsx examples/server.ts

# Terminal 2 — worker (dequeues, retries failures, dead-letters poison)
npx tsx examples/worker.ts
```

## Try it

Single job:

```bash
curl -i -X POST http://127.0.0.1:3000/jobs \
  -H 'Content-Type: application/json' \
  -d '{"payload":"hello"}'
```

Trigger the rate limit (burst of 15 requests against a capacity of 10):

```bash
for i in $(seq 1 15); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3000/jobs \
    -H 'Content-Type: application/json' \
    -d "{\"payload\":\"req-$i\"}"
done
```

Expected: ten `202`s then five `429`s with a `Retry-After` header.

Trigger retry + DLQ:

```bash
curl -X POST http://127.0.0.1:3000/jobs \
  -H 'Content-Type: application/json' \
  -d '{"payload":"POISON"}'
```

In the worker terminal you should see the message attempted three times and then routed to the DLQ.

Inspect the DLQ:

```bash
docker exec -it redis-client-ts-redis redis-cli LRANGE queue:demo-jobs:dlq 0 -1
```

## Crash recovery

Stop the worker mid-job (Ctrl+C while a job is "processing", or `kill -9` it). The message is left in `queue:demo-jobs:inflight:w1`. Restart the worker with the same `WORKER_ID` and watch the startup log — it should print `reclaimed 1 abandoned in-flight message(s)` and then process it.

## Run multiple workers

```bash
# Terminal 2
WORKER_ID=w1 npx tsx examples/worker.ts

# Terminal 3
WORKER_ID=w2 npx tsx examples/worker.ts
```

Each worker has its own in-flight list, so a crash of `w1` is recoverable only by another `w1` (stable IDs are what makes `reclaim()` useful).
