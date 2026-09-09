---
id: 018f3c2a-6b41-7d90-9c11-2f5a7e8d4b03
title: Chunking Rationale
tags:
  - rag
  - chunking
---

# Chunking Rationale

A stable `id:` means this note can be renamed or moved without stranding its row.
With a path-based key a rename is indistinguishable from delete-plus-create.

## Budgets

| Parameter | Value |
| --- | --- |
| target | 384 tokens |
| overlap | 64 tokens |

Overlap costs about 17% more storage and embedding time, which is a fair price for
not losing a sentence that happens to straddle a boundary.
