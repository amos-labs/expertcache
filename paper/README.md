# Paper workspace

Working title:

> ExpertCache: Page-Aware Direct Expert Views for Oversized Sparse Models on
> Apple Silicon

The manuscript is in `main.tex`; current and pending result macros are isolated
in `results.tex`. Replace a `Published*` macro only from reviewed,
machine-readable publication evidence. `CLAIM_LEDGER.md` is the claim boundary
and `EXPERIMENT_PROTOCOL.md` is the registered execution plan.

## Current status

The manuscript structure and current architecture results are written. It is
not submission-ready. Visible `\Pending{}` markers correspond to unfinished
publication gates rather than editorial TODOs.

Run the structural/citation check with:

```bash
npm run paper:check
```

The strict check fails until every result marker is resolved:

```bash
npm run paper:check -- --strict
```

The repository does not yet vendor a TeX distribution. A release workflow must
compile `main.tex`, inspect the resulting PDF, and include both sources and PDF
in the frozen artifact.

The minimal arXiv source archive is built separately from the repository
artifact. See `ARXIV_SUBMISSION.md` and run `npm run paper:bundle`; the command
fails closed while result markers remain.
