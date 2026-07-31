# Publication artifact

This directory defines the release gate and executable experiment matrix.

- `publication-manifest.json` declares current claim grades, unfinished gates,
  and the files included in a release bundle.
- `publication-manifest.schema.json` is the portable schema.
- `experiment-matrix.json` freezes primary runtime flags and the nine-block
  counterbalanced 64 GiB order.
- Generated run records belong in `output/publication/` and are git-ignored
  until reviewed and intentionally promoted into `evidence/publication/`.

Validate the current provisional artifact with:

```bash
npm run artifact:validate
```

Build a checksummed provisional bundle with:

```bash
npm run artifact:bundle -- --allow-provisional
```

The strict release check intentionally fails while any publication gate is not
complete:

```bash
npm run artifact:validate -- --strict
```

