# Recording setup — 2 minutes on your machine

The entry is verified and ready. For the demo video to show the **live
Artifacts** path (strongest entry), do this once on the machine you
record from. Skip it and the demo runs on the zero-setup MemoryStore —
still a truthful entry, since the Artifacts integration is real and
was verified live on 2026-10-12.

## 1. Mint the token (1 minute)

1. Go to https://dash.cloudflare.com → log in (Continue with Google).
2. Top-right profile → **API Tokens** → **Create Token**.
3. **Custom token** → name it `Artifacts Edit Token`.
4. One permission row: **Account** → **Artifacts** → **Edit**.
5. Account Resources: **Include** → your account. Leave IP filtering
   and TTL empty. **Continue to summary** → **Create Token**.
6. **Copy the token value** — it shows once.

## 2. Wire it locally (30 seconds)

In the unzipped `agent-git-entry` folder:

```bash
cp .dev.vars.example .dev.vars
# paste the token after the = sign in .dev.vars
npx wrangler dev
```

Open http://localhost:8787 — run the demo per DEMO_SCRIPT.md.
The Worker now uses real Artifacts (account ID is already in
`wrangler.jsonc`).

## 3. After recording

Keep usage tiny or delete the demo repos afterwards — Artifacts
billing starts Oct 15, 2026. A teardown reminder is set for Oct 14.

## Files

- `.dev.vars.example` — template (copy to `.dev.vars`, never commit it)
- `DEMO_SCRIPT.md` — the ~9 minute walkthrough
- `voiceover/` clips are in the goal folder if you want them again
