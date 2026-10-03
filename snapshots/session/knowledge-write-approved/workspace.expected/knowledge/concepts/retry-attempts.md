---
type: "concept"
title: "Retry attempts"
updated: "{{time}}"
citation:
  session: "{{session:1}}"
  seqs: [15]
  sources: ["src/retry.ts"]
  writer: tool
---

# Retry attempts

`src/retry.ts` exports a single constant, `attempts`, with the value `3`. It defines the number of retry attempts used by the retry logic; the module currently contains no functions, classes, or conditional behavior beyond that literal export.

## Origin

- Session: `{{session:1}}`
- Source events: 15
- Sources: `src/retry.ts`
- Writer: tool
