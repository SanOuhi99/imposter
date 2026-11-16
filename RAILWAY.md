# Deploying Imposter to Railway

The Railway service serves the Vite-built game and the Socket.IO API from one
Node process. Keep them together so room codes, live chat, votes, and reconnects
all reach the same game server.

## Before deploying

1. Push this repository to GitHub.
2. In Railway, create a project and connect the repository from its **root**
   (the directory containing `pnpm-workspace.yaml`).
3. Keep the service at **one replica**. Rooms and player state are currently
   held in server memory; multiple replicas would give players separate rooms.
4. Generate a public Railway domain for the service so players can open the
   site and join with a room code.

## Railway configuration

The service definition is in `.railway/railway.ts`. It builds the web client and
API, starts the combined server, and checks `/api/healthz`. Railway supplies
`PORT` at runtime. The frontend uses the same origin for HTTP and Socket.IO.

If applying the infrastructure definition from a terminal, install or update
the Railway CLI to version 5.42.1 or newer, link the project/environment, then
review and apply the plan:

```sh
railway link
railway config plan
railway config apply
```

Review the plan before applying it, especially if the Railway project already
contains services.

## Current limitation

Room state is in memory, so an app restart or redeploy ends active rooms. The
service is configured for one replica to keep all players in a room together.
Persistent rooms or multiple replicas would require shared state such as Redis.
