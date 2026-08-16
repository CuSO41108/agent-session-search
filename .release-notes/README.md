# Release note format

Every independent development branch with user-visible changes adds exactly one Markdown file in this directory. A branch may omit it only when every changed file is limited to `.github/**`, `AGENTS.md`, this README, or the release-note checker and its tests. Mixing any other path into the branch restores the exactly-one requirement.

```markdown
# 简短的用户可见标题

<!-- release-target: v1 -->

## 新增功能

- ✨ 描述用户现在能看到或使用的新功能。

## Bug 修复

- 描述已经解决的用户可见问题。
```

At least one section must contain a bullet. Omit an empty section. Pending bullets are aggregated into the next GitHub Release and displayed unchanged by the terminal and App update interfaces.

Write this as product copy for users, not as an engineering log. Keep only user-visible features and fixes. Do not mention MRs/PRs, branches, `main`, CI, GitHub Actions, commits, release mechanics, refactors, test counts, internal services, database details, or local paths. Remove internal-only changes. Rewrite useful outcomes to omit private identifiers, hosts, paths, table names, credentials, and organizational details. A few appropriate emoji are welcome when they help users scan the text.

Release routing is explicit for every new note: use `<!-- release-target: v1 -->` for V1 only, `<!-- release-target: v2 -->` for V2 only, or `<!-- release-target: both -->` only when the same user-visible outcome affects both apps. Put the marker immediately after the title. File names and titles never select a target, and a scheduled or manual workflow run publishes only targets with matching pending notes; it does not force a dual release. Routing comments are never shown in public release notes.
