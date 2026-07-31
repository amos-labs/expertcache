# Contributing

ExpertCache is experimental systems research. Changes should be small,
reproducible, and explicit about the quality and host-state gates they affect.

Before opening a pull request:

1. run `npm test` and `npm run check`;
2. keep model weights, private prompts, generated text, credentials, absolute
   local paths, and tenant data out of the repository;
3. pin external runtime and model revisions used for measurements;
4. publish raw machine-readable measurements with the run order and host state;
5. label synthetic ceilings, truncated runs, and decision-grade results as
   such; and
6. include negative results when they change the architectural conclusion.

Runtime changes must preserve deterministic output equivalence against the
current control before performance numbers are considered.
