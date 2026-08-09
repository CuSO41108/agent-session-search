import type { WorkflowDefinition } from "./model";

export function structuredBundledWorkflowDefinitions(agentId: string, now = Date.now()): WorkflowDefinition[] {
  return [{
    id: "resume-technical-highlights",
    name: "简历近期技术亮点补充",
    description: "检查工作目录中的代码项目和 Git 记录，找出已有简历尚未体现且有证据支撑的技术亮点。",
    inputs: [{
      key: "existingResume",
      name: "已有简历内容",
      description: "用于排除简历中已经写过的内容；没有时可以留空。",
      type: "text",
      required: false,
    }],
    nodes: [{
      id: "discover-highlights",
      kind: "agent",
      title: "发现近期技术亮点",
      goal: "从代码与 Git 记录中提炼可用于简历、且现有简历尚未覆盖的近期技术亮点。",
      agentId,
      instructions: [
        "浏览工作目录下的代码项目，识别中间件、架构、性能与明确负责的模块。",
        "检查 Git 提交记录，用代码和提交证据核验候选亮点。",
        "与已有简历逐项比较，删除重复内容。",
        "优先选择能说清问题、技术动作、责任边界和结果的内容。",
      ],
      constraints: [
        "不得编造指标、影响范围或个人职责。",
        "没有足够价值的新增内容时，明确说明原因，不要凑数。",
        "只返回声明的结构化字段，不生成文件。",
      ],
      inputs: [{
        key: "workspace",
        name: "工作目录",
        description: "需要检查的代码项目与 Git 仓库。",
        required: true,
        source: "workspace",
        path: ".",
      }, {
        key: "existingResume",
        name: "已有简历",
        description: "用于识别并排除已经体现的经历与亮点。",
        required: false,
        source: "workflow",
        workflowInputKey: "existingResume",
      }],
      outputs: [{
        key: "highlights",
        name: "新增技术亮点",
        description: "有代码或提交证据、且适合补充进简历的候选亮点。",
        type: "list",
        required: true,
        item: {
          key: "highlight",
          name: "技术亮点",
          description: "一条可核验的简历候选内容。",
          type: "object",
          required: true,
          fields: [
            { key: "title", name: "亮点标题", description: "简短概括技术主题。", type: "text", required: true },
            { key: "category", name: "技术类别", description: "中间件、架构、性能或负责模块。", type: "text", required: true },
            { key: "bullet", name: "简历表述", description: "可继续润色的简历 bullet。", type: "text", required: true },
            { key: "evidence", name: "证据", description: "相关项目、文件或 Git 提交依据。", type: "text", required: true },
            { key: "confidence", name: "可信度", description: "high、medium 或 low，并说明判断依据。", type: "text", required: true },
          ],
        },
      }, {
        key: "scannedProjects",
        name: "已检查项目",
        description: "本次实际检查过的项目或仓库。",
        type: "list",
        required: true,
        item: { key: "project", name: "项目", description: "项目名称或相对路径。", type: "text", required: true },
      }, {
        key: "noValueReason",
        name: "无新增说明",
        description: "没有值得补充的亮点时说明原因；有亮点时留空。",
        type: "text",
        required: false,
      }],
      acceptanceCriteria: [
        "每条亮点都包含具体证据与责任边界。",
        "候选内容不与已有简历重复。",
        "无新增亮点时，scannedProjects 和 noValueReason 仍完整。",
      ],
    }],
    createdAt: now,
    updatedAt: now,
  }];
}
