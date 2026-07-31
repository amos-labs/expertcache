# AI assistance and human accountability

ExpertCache was developed through a human-led, AI-assisted research process.
Rick Barkley is the sole human author of the present software artifact and
manuscript draft. AI systems are not authors: they cannot approve the final
claims, accept responsibility for errors, disclose conflicts, or answer for
the integrity of the measurements.

## Roles

- **Rick Barkley** defined the research question, architecture and memory
  boundaries; operated the test hardware; approved or rejected experimental
  arms; reviewed the code and evidence; and retains responsibility for every
  published claim.
- **Fable** assisted with iterative experiment design, code synthesis,
  debugging, test formulation, and technical summaries during the original
  ExpertCache sequence.
- **OpenAI GPT Sol** assisted with code and documentation review, repository
  extraction, artifact validation, publication scaffolding, and manuscript
  refinement.

The exact service-side model version was not captured for every interaction in
the original July 2026 development sequence. That is a provenance limitation,
not a reason to invent version metadata after the fact. Future publication
runs must record the available model/tool identity in their run manifest.

## Verification policy

AI-generated or AI-modified material is accepted only after human review and
an appropriate deterministic, quality, or empirical gate. In particular:

- runtime changes must preserve output-equivalence and targeted hidden tests;
- performance claims must point to machine-readable evidence and disclose host
  state, run order, and exclusions;
- citations must be checked against primary sources;
- model output is never treated as measurement evidence; and
- the human author makes the final decision to publish, retract, or qualify a
  result.

## Paper disclosure

The manuscript discloses AI assistance in both the methodology and
acknowledgments. Fable and GPT Sol must not be placed in the author block or
assigned ORCID-like identifiers. Full responsibility for originality,
accuracy, code integrity, and empirical findings remains with the human
author.

