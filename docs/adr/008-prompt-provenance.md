# ADR-008: Prompt provenance — principles yes, text never

**Status:** Accepted

## Decision

All prompt text in this repository must be original work, written from BUILD_BRIEF.md's requirements and the validator's checks. Principles learned from studying production tools (streaming-safe formats, editability constraints, verifier passes) may inform the requirements; reproducing, adapting, or closely paraphrasing another tool's prompt text is prohibited. This binds human and AI contributors equally. Prompt PRs are reviewed for provenance.

## Rationale

Legal cleanliness (prompt text of proprietary tools is not licensed for reuse), community trust in an Apache-2.0 project, and engineering honesty: the eval harness (M1), not borrowed incantations, is the mechanism that pulls prompt quality up.
