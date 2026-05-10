# Examples

Drop-in scripts showing how to consume `agent-conductor` from real code.

| File | What it shows |
|------|---------------|
| `standalone-script.mjs` | Build a snapshot + print next-step per session. Pure Node, no framework. |
| `express-dashboard.mjs`  | Expose every primitive over HTTP via `node:http` (zero deps). A real dashboard would add CORS, auth, validation. |

## Run

```bash
# After `npm install agent-conductor`:
node examples/standalone-script.mjs
node examples/express-dashboard.mjs            # listens on :8765
PORT=4000 LIST=Personal node examples/express-dashboard.mjs

# In another terminal:
curl http://localhost:8765/api/snapshot | jq
curl http://localhost:8765/api/todos | jq
curl -X POST -H 'content-type: application/json' \
  -d '{"title":"From the example","notes":"pid:1234 repo:demo-app phase:plan"}' \
  http://localhost:8765/api/todos | jq
```

## Discover providers

Both examples use `claudeCodeProvider.discover()`. If you're building for another agent CLI, implement the `DiscoveryProvider` interface from `agent-conductor/discovery` and swap it in:

```typescript
import { buildSnapshot } from "agent-conductor";
import type { DiscoveryProvider } from "agent-conductor/discovery";

const myProvider: DiscoveryProvider = {
  name: "my-coding-cli",
  async discover() {
    // Return LocalSession[] here. See src/types/local-session.ts for the shape.
  },
};

const sessions = await myProvider.discover();
const snap = await buildSnapshot(sessions);
```
