# arXiv submission checklist

This checklist is intentionally separate from the research artifact bundle.
The arXiv upload contains only the sources required to compile the paper; the
repository release carries code, evidence, manifests, and raw results.

## Release gates

- [ ] Every P0 row in `ROADMAP.md` is complete or explicitly scoped out.
- [ ] `npm run paper:check -- --strict` passes with zero `\Pending{}` markers.
- [ ] The final claim ledger matches the machine-readable evidence.
- [ ] `main.tex` compiles from a clean directory with no local absolute paths.
- [ ] The compiled PDF has been rendered page-by-page and visually inspected.
- [ ] References resolve, tables fit, links work, and no result is colored red.
- [ ] The author name, title, abstract, category, comments, and license choice
  have been reviewed by the human author.
- [ ] AI assistance remains disclosed in Methodology and Acknowledgments; AI
  systems are not listed as authors.

## Source package

Run:

```bash
npm run paper:bundle
```

The command refuses provisional manuscript markers. For compile-path testing
only, `npm run paper:bundle -- --allow-provisional` creates an archive whose
filename and manifest state are explicitly provisional.

The archive includes only:

- `main.tex`
- `results.tex`
- `references.bib`
- `main.bbl`, when a local compile has generated it

Do not upload the repository, experiment outputs, model files, raw evidence,
private paths, or the compiled PDF when TeX source is available. Inspect the
archive contents before upload, then use arXiv's detected compiler and preview
to verify the server-rendered result.

## Submission notes

- arXiv currently prefers TeX/LaTeX and asks authors to upload the sources
  needed to compile the paper.
- File names must use arXiv's portable character set and are case-sensitive.
- A new author or a new category may require endorsement.
- The submitter must choose an arXiv license and accept the submittal
  agreement; the repository's Apache-2.0 software license does not make that
  paper-license decision automatically.
- Upload only after the human author has approved the scientific claims and
  the generated PDF.

Official references:

- <https://info.arxiv.org/help/submit/index.html>
- <https://info.arxiv.org/help/submit_tex.html>
- <https://info.arxiv.org/help/license/index.html>
