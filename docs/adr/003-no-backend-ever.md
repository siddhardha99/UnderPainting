# ADR-003: No backend ever; git is the collaboration layer

**Status:** Accepted

## Decision

Underpainting ships no server. All state is plain, schema-versioned, git-diffable files under the workspace's `.design/` directory. Teams collaborate by committing them.

## Rationale

The product's core promise is that prompts, code context, and brand assets never flow through a third party other than the API the user already chose (OpenRouter). A backend — even a "sync" backend — breaks that promise, creates an accounts/monetization gravity well, and adds an operational burden an OSS project doesn't need. Git already solves versioned, permissioned, distributed collaboration for files.
