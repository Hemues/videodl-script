# Lessons Learned Maintenance Guide

This file explains how to maintain `LESSONS-LEARNED.md` for the `scripts/videodl-script` project.

## Purpose

`LESSONS-LEARNED.md` captures recurring bugs, architecture decisions, extractor regressions, and maintenance patterns that help future debugging and development.

## When to update

Update or add an entry when you:

- fix a broken site extractor
- change a downloader or HLS implementation
- resolve a recurring bug pattern
- learn a non-obvious workaround for a site-specific issue
- update the docs or release process based on experience

## How to update

1. Identify the relevant fix and files.
   - Use `git log --oneline -- <file>` to see when the affected code last changed.
   - Use `git diff -- <file>` to summarize what changed.
   - If the file did not exist, create it with the standard header and section structure.

2. Add a new numbered section to `LESSONS-LEARNED.md`.
   - Update the Table of Contents.
   - Use the template below.

3. Keep entries concise and focused.
   - include the symptom
   - include the root cause
   - include the fix
   - mark status and verification
   - include the last update date

## Recommended entry template

```md
## #N — Short title

**Status:** ✅ VERIFIED or ⏳ PENDING VERIFICATION

**Symptom:**
Describe the user-facing failure or bug symptom.

**Root Cause:**
Describe why the failure happened in code or architecture terms.

**Fix:**
Describe the concrete code or configuration change that resolved it.

**Verification:**
Describe how the fix was tested.

**Last update:** YYYY-MM-DD
```

## If the file does not exist

Create `LESSONS-LEARNED.md` with this structure:

```md
# VideoDL Script — Lessons Learned

Reference for developing and maintaining the VideoDL CLI video downloader.

Entries marked ✅ are verified in production. Entries marked ⏳ are pending verification.

---

## Table of Contents

1. [Site Extractors Break Frequently](#1--site-extractors-break-frequently)

---

## #1 — Site Extractors Break Frequently

**Status:** ✅ VERIFIED

**Symptom:**
...

**Root Cause:**
...

**Fix:**
...

**Last update:** YYYY-MM-DD
```

## Linking to git history

When documenting a fix, include the relevant commit or branch if it is available.
Use `git log --oneline -- <file>` to capture the most recent change, and note the date.

Example:

- `Last update: 2026-04-17`
- `Relevant commit: d52e4f0`

## Future process

- Always update the Table of Contents when adding a section.
- Prefer short, actionable lessons over long narratives.
- Place lessons near the top of the file if they cover frequently changing extractor behavior.
- Keep the document in the same repository folder as the code it describes.
- If a fix is later reverted, add a follow-up lesson explaining why.

## Commit message guideline

Use a clear commit message such as:

```text
docs: update lessons learned for AShemaleTube embed format fix
```
