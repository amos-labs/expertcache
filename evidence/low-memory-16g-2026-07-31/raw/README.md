# Sanitized raw low-memory outputs

This directory preserves every `baseline.json` and `llama-server.log` from the
registered run, warm engineering search, invalid launch control, and final
clean-session confirmation.

Only three machine-local values were changed for public distribution:

- the absolute local worktree path became `$WORKTREE`;
- the stable host fingerprint became `redacted`; and
- the battery device identifier became `redacted`.

No timing, memory, VM counter, process sample, configuration, response,
failure, or server-log event was removed or changed. `../raw-manifest.json`
records the source output path, original SHA-256, published SHA-256, and byte
sizes for every file. The sanitized files intentionally have different hashes
from the local originals retained in the summary records.

The 63.4 GB model and compiled `.cache` tree are not included. Their pinned
identities and build inputs are recorded in the manifest and result summaries.
