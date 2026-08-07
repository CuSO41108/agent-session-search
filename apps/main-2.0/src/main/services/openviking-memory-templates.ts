import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MEMORY_TEMPLATES = {
  "decisions.yaml": `memory_type: decisions
description: |
  Project decision memory. Extract durable choices that affect future work.
  Keep the decision, its context, current status, rejected alternatives, and later evolution together.
  A superseded decision must update the existing item instead of remaining active beside its replacement.
directory: "viking://user/{{ user_space }}/memories/decisions"
filename_template: "{{ decision_key }}.md"
enabled: true
operation_mode: "upsert"
embedding_template: |-
  {{ decision_key }}

  {{ decision }}

  {{ context }}
overview_template: |-
  # Decisions
  {% for item in items %}
  - [{{ item.file_content.decision_key|default(item.file_name, true) }}](./{{ item.file_name }}) — {{ item.file_content.status }}
  {% endfor %}
fields:
  - name: decision_key
    type: string
    description: Stable concise identifier for the decision, written in {{ language }}.
    merge_op: immutable
  - name: context
    type: string
    description: Why the decision was needed and the constraints that shaped it, written in {{ language }}.
    merge_op: patch
  - name: decision
    type: string
    description: The current authoritative choice and its practical consequence, written in {{ language }}.
    merge_op: replace
  - name: status
    type: string
    description: One of proposed, active, superseded, rejected, or completed.
    merge_op: replace
  - name: alternatives
    type: string
    description: Rejected or deferred alternatives and the reason each was not selected, written in {{ language }}.
    merge_op: patch
  - name: evolution
    type: string
    description: Later corrections or replacements that explain how the decision changed, written in {{ language }}.
    merge_op: patch
`,
  "open_loops.yaml": `memory_type: open_loops
description: |
  Project follow-up memory. Extract concrete unfinished work, the next action, owner, and current status.
  Do not keep completed or cancelled items active. Update the existing item when its status changes.
directory: "viking://user/{{ user_space }}/memories/open_loops"
filename_template: "{{ loop_key }}.md"
enabled: true
operation_mode: "upsert"
embedding_template: |-
  {{ loop_key }}

  {{ item }}

  {{ next_step }}
overview_template: |-
  # Open Loops
  {% for item in items %}
  - [{{ item.file_content.loop_key|default(item.file_name, true) }}](./{{ item.file_name }}) — {{ item.file_content.status }}
  {% endfor %}
fields:
  - name: loop_key
    type: string
    description: Stable concise identifier for this follow-up item, written in {{ language }}.
    merge_op: immutable
  - name: item
    type: string
    description: The concrete unresolved obligation or question, written in {{ language }}.
    merge_op: replace
  - name: next_step
    type: string
    description: The next observable action needed to move the item forward, written in {{ language }}.
    merge_op: replace
  - name: owner
    type: string
    description: Responsible person or role. Use unknown when no owner was established.
    merge_op: replace
  - name: status
    type: string
    description: One of open, blocked, completed, or cancelled. Completed and cancelled items must not remain active open loops.
    merge_op: replace
`,
} as const;

export async function ensureOpenVikingMemoryTemplates(rootDir: string): Promise<string> {
  const directory = path.join(path.resolve(rootDir), "memory-templates");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await Promise.all(Object.entries(MEMORY_TEMPLATES).map(async ([name, content]) => {
    const target = path.join(directory, name);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, target);
      if (process.platform !== "win32") await chmod(target, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  }));
  return directory;
}
