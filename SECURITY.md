# Security

Do not use private, tenant, customer, or credential-bearing prompts in trace
capture. The committed trace format records selected expert IDs and bounded
metadata only; prompt and generated text must not enter trace artifacts.

Do not report security vulnerabilities in public issues. Contact AMOS Labs
through the private security channel listed at https://amoslabs.com.

This repository is experimental research software and is not intended to
process production data or expose a network service without an independent
security review.
