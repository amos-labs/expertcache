# Evidence bundles

These files are the decision-grade bundles committed with the original
ExpertCache experiments. They preserve numerical measurements, model/runtime
pins, run ordering, synthetic probe prompts, generated probe output, and the
targeted qualification result.

During extraction from `amos-agent`, machine-local absolute paths were
normalized to `/models`, `/runtime`, and `/output`. No timings, scores, token
counts, generated content, runtime pins, model pins, or experimental settings
were changed.

The bundles are not yet publication-grade statistics. Several runs occurred on
a host with accumulated page-cache or swap state; the adjacent README files and
the main result documents identify those limitations. A final arXiv artifact
must add repeated, counterbalanced, clean-host measurements rather than
silently promoting these runs.

The [2026-07-31 qualification control bundle](qualification-controls-2026-07-31/)
adds complete synthetic response capture for local low/medium diagnostics,
matched Bedrock controls, a versioned evaluator audit, and a clean-source
targeted coding follow-up. Its README defines why raw-model, evaluator-audit,
and governed-system results remain separate.
