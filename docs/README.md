# docs

Human-facing documentation for xcurate.

| Document | What it covers |
|---|---|
| [**architecture.md**](architecture.md) | How the system works: the deterministic/judgement split, the read-only guarantee, the pipeline stage by stage, the data model, and the design constraints. **Start here.** |
| [knowledge-graph.md](knowledge-graph.md) | A compressed entity/relation index of the whole repo — constants, invariants, and `file.ts:NN` anchors. Written for agents to load instead of re-reading `src/`; humans want `architecture.md`. |

Elsewhere in the repo:

| File | Purpose |
|---|---|
| [`../README.md`](../README.md) | What xcurate is, and how to set it up |
| [`../manual-run.md`](../manual-run.md) | The runbook — running, inspecting, and fixing things by hand |
| [`../xcurate.md`](../xcurate.md) | The full build spec, with the `§` section numbers the code cites |
| [`../CLAUDE.md`](../CLAUDE.md) | Always-loaded rules for agents working in this repo |
| [`../ops/local-model-runbook.md`](../ops/local-model-runbook.md) | Running the local Ollama classifier and its eval |
