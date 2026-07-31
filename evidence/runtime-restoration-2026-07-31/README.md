# Runtime restoration evidence

This bundle records restoration of the exact publication checkpoint and
runtime on the primary 64 GiB M1 Max host. The checkpoint is not redistributed.

- `restoration.json` records immutable revisions, byte size, and digests.
- `native-mxfp4-ops.csv` is a filtered `test-backend-ops` correctness result
  from the physical Metal backend.

The larger `MUL_MAT_ID` backend suite also completed successfully during the
restoration session. The committed filtered case is the tensor shape and type
that directly covers the publication runtime's MXFP4 routed operation.
