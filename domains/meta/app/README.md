# Agentic OS — Dashboard

The OS's first app. Visual surface for inspecting and managing the OS itself.

## Run

```bash
npm install
npm run dev
```

- Frontend: <http://localhost:5173>
- API:      <http://localhost:5174>

## Architecture

- **Frontend**: Vite + React. Sidebar nav + view switcher.
- **Backend**: Fastify on 5174, proxied by Vite at `/api/*`.
- **Reads**: direct filesystem (`server/routes/{vault,skills,domains,router-log,curation}.ts`).
- **Writes (simple)**: direct fs (`server/routes/edit.ts`).
- **Writes (AI)**: shell out to the `claude` CLI (`server/routes/action.ts`), stream output back via SSE.
- **Auth**: no-op middleware in `server/auth.ts` — replace with a token check before exposing via tunnel.

## Views (v1)

| view | what |
|------|------|
| Overview | stats + curation queue badge |
| Domains | browse playbooks |
| Skills | browse skills with frontmatter |
| Vault | raw / wiki / output browser w/ archetype filters + search |
| Router | dispatch telemetry + miss rate |
| Curation | pending raw items, mark/ignore |

## Standards

See `vault/wiki/_seed/meta/reference/standard-app-layout.md` for the layout this conforms to.
