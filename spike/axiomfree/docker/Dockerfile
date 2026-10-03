# Task 2b: lax's pinned image family plus bubblewrap, to test whether bwrap
# (the sandbox `lake comparator` / `lake check` require) can run inside the
# container sandbox lax already has.
FROM node:22-bookworm-slim@sha256:a17d50af28002a160548bd4225b3cfcb12c5efcb171f79e68758f2885fb1b066
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap && rm -rf /var/lib/apt/lists/*
