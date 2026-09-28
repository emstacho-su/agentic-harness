# Phase 7 — retrieval polish

Status: in progress. Owner: Stack.

## 1. Goal

Search answers a class question with the right lecture in the top three, and says so when
nothing relevant exists instead of guessing.

## 2. Scope

| Area | In | Out |
| --- | --- | --- |
| Ranking | similarity floor, per-document cap | a reranker |
| UI | empty-result message | redesign |

## 3. Checklist

- [x] Similarity floor at 0.70 on the vector arm
- [x] Per-document cap of three chunks
- [ ] Empty-result message in the chat panel, worded as an answer
  rather than an error
- [ ] Golden cases for every course

## 4. Done when

Hit@3 at or above 0.95 on the golden set and the empty-result message shipped.
