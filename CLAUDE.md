# Ginger Dashboard

Status dashboard for tracking all of Ginger's projects. Owned and maintained by RHM.

## Architecture

- **Cloudflare Worker** - Serves dashboard UI and REST API
- **D1 Database** - Stores projects, features, test logs, file changes
- **Durable Objects** - WebSocket connections for live updates

## Key Concepts

### Trust Model

- `.test-log.jsonl` in each project = raw test events from Claude Code
- D1 database = curated, verified status (RHM is gatekeeper)
- "Browser tested" = RHM has verified and would advise pushing to production

### Data Flow

1. Claude Code runs tests → writes to `.test-log.jsonl`
2. RHM reviews and syncs verified data to D1
3. Dashboard reads from D1
4. Durable Objects push live updates to connected browsers

## API Endpoints

- `GET /api/projects` - List all projects
- `GET /api/projects/:id` - Get project with features
- `GET /api/features/:id` - Get feature with test history
- `POST /api/projects` - Create project
- `POST /api/features` - Create feature
- `PATCH /api/features/:id` - Update feature status
- `POST /api/test-logs` - Log a test
- `POST /api/file-changes` - Log a file change
- `GET /api/ws` - WebSocket for live updates

## Development

```bash
# Install dependencies
pnpm install

# Create D1 database (first time)
wrangler d1 create ginger-dashboard-db

# Run migrations
pnpm db:migrate

# Local dev
pnpm dev

# Deploy to staging
pnpm deploy:staging
```

## Deployment

- Staging: `https://ginger-dashboard-staging.<account>.workers.dev`
- Production: TBD (maybe custom domain)
