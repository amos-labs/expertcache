# Provisional arXiv metadata

Do not paste this into arXiv until the release gates and final PDF review pass.

## Title

ExpertCache: Page-Aware Direct Expert Views for Oversized Sparse Models on
Apple Silicon

## Authors

Rick Barkley (AMOS Labs)

AI systems are disclosed in the paper but are not authors.

## Category recommendation

- Suggested primary: `cs.AR` (Hardware Architecture). The contribution changes
  the Metal resource/working-set boundary and grouped sparse-kernel dispatch on
  a specific unified-memory architecture.
- Suggested cross-list: `cs.PF` (Performance). The paper measures latency,
  throughput, resource usage, and negative performance results.
- Optional cross-list: `cs.OS` (Operating Systems), if the final paper retains
  substantial page-residency, VM, and memory-pressure analysis.

Do not use `cs.LG` merely because the evaluated artifact is a language model;
the current contribution is a systems/runtime result rather than a new
learning method. Final category selection remains the author's decision and
may be adjusted by arXiv moderation.

Official taxonomy: <https://arxiv.org/category_taxonomy>

## Abstract

Copy the final plain-text abstract from `main.tex` only after all result macros
have been replaced from reviewed evidence. Remove TeX commands and verify that
the metadata abstract exactly matches the paper.

## Comments

TBD after final compile: page count, figure/table count, and artifact URL.

Suggested structure:

> [N] pages, 1 figure, 1 table. Code and reproducibility artifact:
> https://github.com/amos-labs/expertcache

## License

Select **CC BY 4.0 (Creative Commons Attribution)**. The human author approved
this choice on 2026-07-31. The manuscript/PDF are CC BY 4.0; software remains
Apache-2.0. The selected arXiv license is irrevocable, so verify the form one
last time before submitting.

## Journal reference, DOI, report number

Leave blank for the initial preprint unless an applicable identifier already
exists. Add publication metadata through arXiv's update workflow later.
