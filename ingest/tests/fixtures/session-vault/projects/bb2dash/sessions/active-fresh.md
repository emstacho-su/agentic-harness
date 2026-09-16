---
id: session-22222222-2222-4222-8222-222222222222
title: Materials exporter
type: session
collection: bb2dash
schema_version: 1
session_id: 22222222-2222-4222-8222-222222222222
date: 2026-09-15
started_at: 2026-09-15T07:00:00+00:00
ended_at: 2026-09-15T08:00:00+00:00
duration_minutes: 60
end_reason: clear
agent: claude-code
status: active
repo: emstacho-su/bb2dash
branch: feat/vault-materials-export
phase: phase-10
tags:
  - ingest
---

# Materials exporter

Wrote the bb2dash materials exporter and confirmed every exported note carries
`ingest: false` so the two vector spaces never mix.
