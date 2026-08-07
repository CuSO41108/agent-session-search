import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  Square,
} from "lucide-react";

import type {
  OpenVikingDiagnosticsSnapshot,
  OpenVikingRuntimeHealth,
  OpenVikingRuntimeState,
  OpenVikingWorkspace,
} from "../../../../core/openviking-memory";
import type {
  OpenVikingCommitRun,
  OpenVikingControlDiagnostics,
  OpenVikingOperationEvent,
  OpenVikingRecallTrace,
} from "../../../../core/openviking-memory-control";
import { localize, type LanguageMode } from "../../language";

type RuntimeAction = "start" | "restart" | "stop" | "refresh" | null;

export function OpenVikingRuntimeMonitor({
  language,
}: {
  language: LanguageMode;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [snapshot, setSnapshot] = useState<OpenVikingDiagnosticsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compatibilityMode, setCompatibilityMode] = useState(false);
  const [action, setAction] = useState<RuntimeAction>(null);
  const requestPending = useRef(false);
  const mounted = useRef(true);

  const refresh = useCallback(async (manual = false) => {
    if (requestPending.current) return;
    requestPending.current = true;
    if (manual) setAction("refresh");
    try {
      const next = await readDiagnostics();
      if (!mounted.current) return;
      setSnapshot(next.snapshot);
      setCompatibilityMode(next.compatibilityMode);
      setError(null);
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      requestPending.current = false;
      if (mounted.current && manual) setAction(null);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_500);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const controlRuntime = async (nextAction: Exclude<RuntimeAction, "refresh" | null>) => {
    setAction(nextAction);
    setError(null);
    try {
      if (nextAction === "start") await window.sessionSearch.startOpenVikingRuntime();
      else if (nextAction === "restart") await restartRuntime();
      else await window.sessionSearch.stopOpenVikingRuntime();
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      if (mounted.current) setAction(null);
    }
  };

  const runtime = snapshot?.runtime;
  const runtimeState = runtime?.status.state;
  const runtimeBusy = action !== null || runtimeState === "starting" || runtimeState === "installing";
  const canStart = runtimeState === "stopped" || runtimeState === "error";
  const canStop = runtimeState === "running" || runtimeState === "starting";

  return (
    <div className="openviking-runtime-monitor">
      <section className="openviking-runtime-hero">
        <div className="openviking-runtime-identity">
          <span className={`openviking-runtime-mark ${runtime?.health ?? "not-running"}`}>
            <Server size={21} />
          </span>
          <div>
            <div>
              <h3>OpenViking</h3>
              <RuntimeStateBadge state={runtimeState} language={language} />
              {runtime ? <HealthBadge health={runtime.health} language={language} /> : null}
            </div>
            <p>{l(
              "Local memory runtime and directory-level incremental tracking.",
              "本地记忆服务与目录级增量跟踪的实时状态。",
            )}</p>
          </div>
        </div>
        <div className="openviking-runtime-controls">
          <button
            type="button"
            onClick={() => void refresh(true)}
            disabled={action !== null}
            title={l("Refresh now", "立即刷新")}
          >
            <RefreshCw size={14} className={action === "refresh" ? "spin" : ""} />
            {l("Refresh", "刷新")}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void controlRuntime("start")}
            disabled={!canStart || runtimeBusy}
          >
            {action === "start"
              ? <><RefreshCw size={14} className="spin" />{l("Starting", "启动中")}</>
              : <><Play size={14} />{l("Start", "启动")}</>}
          </button>
          <button
            type="button"
            onClick={() => void controlRuntime("restart")}
            disabled={runtimeState !== "running" || runtimeBusy}
          >
            {action === "restart"
              ? <><RefreshCw size={14} className="spin" />{l("Restarting", "重启中")}</>
              : <><RotateCcw size={14} />{l("Restart", "重启")}</>}
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => void controlRuntime("stop")}
            disabled={!canStop || runtimeBusy}
          >
            {action === "stop"
              ? <><RefreshCw size={13} className="spin" />{l("Stopping", "关闭中")}</>
              : <><Square size={13} />{l("Stop", "关闭")}</>}
          </button>
        </div>
      </section>

      {error ? (
        <div className="openviking-runtime-warning">
          <AlertTriangle size={15} />
          <span>{error}</span>
          {snapshot ? <em>{l("Showing the last successful snapshot.", "当前保留上一次成功读取的状态。")}</em> : null}
        </div>
      ) : null}

      {compatibilityMode ? (
        <div className="openviking-runtime-warning compatibility">
          <AlertTriangle size={15} />
          <span>{l(
            "Basic status and controls are available now. Restart V2 normally to load process health and runtime events.",
            "基础状态与控制现在已可用；请正常重启 V2，以加载进程健康与运行事件。",
          )}</span>
        </div>
      ) : null}

      {!snapshot ? (
        <div className="openviking-runtime-loading">
          <RefreshCw size={18} className="spin" />{l("Reading OpenViking status…", "正在读取 OpenViking 状态…")}
        </div>
      ) : (
        <>
          <section className="openviking-runtime-facts">
            <RuntimeFact
              icon={<Activity size={16} />}
              label={l("Process", "进程")}
              value={runtime?.pid
                ? `PID ${runtime.pid}`
                : runtimeState === "running"
                  ? l("Running", "运行中")
                  : l("Not running", "未运行")}
              detail={runtime?.port ? `127.0.0.1:${runtime.port}` : runtimeStateLabel(runtimeState, language)}
            />
            <RuntimeFact
              icon={<Clock3 size={16} />}
              label={l("Uptime", "运行时长")}
              value={runtimeState === "running" && runtime?.uptimeSeconds === undefined
                ? l("Unavailable", "暂不可用")
                : formatDuration(runtime?.uptimeSeconds, language)}
              detail={runtime?.startedAt
                ? l(`Started ${formatTime(runtime.startedAt, language)}`, `启动于 ${formatTime(runtime.startedAt, language)}`)
                : runtimeState === "running"
                  ? l("The current window did not provide a start time", "当前窗口未提供启动时间")
                  : l("No active process", "当前没有活动进程")}
            />
            <RuntimeFact
              icon={<CheckCircle2 size={16} />}
              label={l("Health probe", "健康检查")}
              value={runtime?.health === "healthy" ? l("Available", "可用") : healthLabel(runtime?.health, language)}
              detail={runtime?.healthLatencyMs === undefined
                ? runtimeState === "running"
                  ? l("The current window did not provide probe latency", "当前窗口未提供探测耗时")
                  : l("Waiting for a running service", "等待服务启动")
                : `${runtime.healthLatencyMs} ms`}
            />
            <RuntimeFact
              icon={<Database size={16} />}
              label={l("Components", "组件")}
              value={runtime?.status.version
                ? `OpenViking ${runtime.status.version}`
                : l("Runtime unavailable", "运行组件不可用")}
              detail={l(
                `${formatBytes(runtime?.status.installedBytes)} · model ${snapshot.model.installed ? "ready" : "missing"}`,
                `${formatBytes(runtime?.status.installedBytes)} · 向量模型${snapshot.model.installed ? "已就绪" : "未安装"}`,
              )}
            />
          </section>

          <section className="openviking-runtime-section">
            <header>
              <div>
                <h3>{l("Directory tracking", "目录跟踪")}</h3>
                <p>{l(
                  "Only future turns in managed directories are captured; historical sessions are not bulk-imported.",
                  "只捕获受管理目录中未来产生的对话；历史会话不会被批量导入。",
                )}</p>
              </div>
              <span>{l(`${snapshot.workspaces.length} directories`, `${snapshot.workspaces.length} 个目录`)}</span>
            </header>
            {snapshot.workspaces.length === 0 ? (
              <div className="openviking-runtime-empty">
                {l("No memory directories are configured.", "还没有配置记忆目录。")}
              </div>
            ) : (
              <div className="openviking-runtime-workspaces">
                {snapshot.workspaces.map((workspace) => (
                  <WorkspaceDiagnostics
                    key={workspace.id}
                    workspace={workspace}
                    language={language}
                  />
                ))}
              </div>
            )}
          </section>

          <ControlDiagnostics
            control={snapshot.control}
            workspaces={snapshot.workspaces}
            language={language}
          />

          <section className="openviking-runtime-section openviking-runtime-events">
            <header>
              <div>
                <h3>{l("Runtime events", "运行事件")}</h3>
                <p>{l("Recent lifecycle events from this app session.", "当前应用会话内最近的生命周期事件。")}</p>
              </div>
              <span>{l(`Updated ${formatTime(snapshot.capturedAt, language)}`, `更新于 ${formatTime(snapshot.capturedAt, language)}`)}</span>
            </header>
            {runtime?.events.length ? (
              <div>
                {runtime.events.map((event) => (
                  <article className={event.level} key={event.id}>
                    <i aria-hidden="true" />
                    <span>{event.message}</span>
                    <time>{formatTime(event.createdAt, language)}</time>
                  </article>
                ))}
              </div>
            ) : (
              <div className="openviking-runtime-empty">{l("No runtime events yet.", "暂无运行事件。")}</div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function ControlDiagnostics({
  control,
  workspaces,
  language,
}: {
  control: OpenVikingControlDiagnostics;
  workspaces: OpenVikingWorkspace[];
  language: LanguageMode;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.displayName]));
  return (
    <section className="openviking-runtime-section openviking-control-diagnostics">
      <header>
        <div>
          <h3>{l("Memory pipeline", "记忆流水线")}</h3>
          <p>{l(
            "Commit extraction, stage timing and recall decisions recorded by AgentRecall.",
            "AgentRecall 记录的提交提炼、阶段耗时与召回决策。",
          )}</p>
        </div>
        <span>{l(
          `${control.recentCommits.length} commits · ${control.recentRecallTraces.length} recalls`,
          `${control.recentCommits.length} 次提交 · ${control.recentRecallTraces.length} 次召回`,
        )}</span>
      </header>
      <div className="openviking-control-columns">
        <ControlColumn title={l("Extraction runs", "提炼任务")} empty={l("No extraction runs yet.", "暂无提炼任务。")}>
          {control.recentCommits.slice(0, 8).map((run) => (
            <CommitRow
              key={run.taskId}
              run={run}
              workspaceName={workspaceNames.get(run.workspaceId) ?? run.workspaceId}
              language={language}
            />
          ))}
        </ControlColumn>
        <ControlColumn title={l("Pipeline stages", "处理阶段")} empty={l("No stage events yet.", "暂无阶段事件。")}>
          {control.recentEvents.slice(0, 10).map((event) => (
            <OperationRow
              key={event.id}
              event={event}
              workspaceName={workspaceNames.get(event.workspaceId) ?? event.workspaceId}
              language={language}
            />
          ))}
        </ControlColumn>
        <ControlColumn title={l("Recall traces", "召回记录")} empty={l("No recall traces yet.", "暂无召回记录。")}>
          {control.recentRecallTraces.slice(0, 8).map((trace) => (
            <RecallRow
              key={trace.id}
              trace={trace}
              workspaceName={workspaceNames.get(trace.workspaceId) ?? trace.workspaceId}
              language={language}
            />
          ))}
        </ControlColumn>
      </div>
    </section>
  );
}

function ControlColumn({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: ReactElement[];
}): ReactElement {
  return (
    <div className="openviking-control-column">
      <strong>{title}</strong>
      <div>{children.length > 0 ? children : <span className="openviking-control-empty">{empty}</span>}</div>
    </div>
  );
}

function CommitRow({
  run,
  workspaceName,
  language,
}: {
  run: OpenVikingCommitRun;
  workspaceName: string;
  language: LanguageMode;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <article className="openviking-control-row">
      <div>
        <strong title={run.taskId}>{workspaceName} · {triggerLabel(run.trigger, language)}</strong>
        <span>{l(
          `${run.sourceTurnIds.length} turns · ~${run.tokenEstimate} tokens`,
          `${run.sourceTurnIds.length} 个 Turn · 约 ${run.tokenEstimate} Token`,
        )}</span>
        {run.error ? <em className="error">{run.error}</em> : null}
      </div>
      <aside>
        <span className={`openviking-runtime-state ${run.state}`}>{commitStateLabel(run.state, language)}</span>
        <time>{formatTime(run.updatedAt, language)}</time>
      </aside>
    </article>
  );
}

function OperationRow({
  event,
  workspaceName,
  language,
}: {
  event: OpenVikingOperationEvent;
  workspaceName: string;
  language: LanguageMode;
}): ReactElement {
  return (
    <article className="openviking-control-row">
      <div>
        <strong>{phaseLabel(event.phase, language)}</strong>
        <span>{workspaceName}{event.taskId ? ` · ${shortId(event.taskId)}` : ""}</span>
      </div>
      <aside>
        <span className={`openviking-runtime-state ${event.status}`}>{operationStateLabel(event.status, language)}</span>
        <time>{event.durationMs === undefined ? formatTime(event.startedAt, language) : formatDurationMs(event.durationMs)}</time>
      </aside>
    </article>
  );
}

function RecallRow({
  trace,
  workspaceName,
  language,
}: {
  trace: OpenVikingRecallTrace;
  workspaceName: string;
  language: LanguageMode;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <article className="openviking-control-row">
      <div>
        <strong title={trace.query}>{trace.query || l("Empty query", "空查询")}</strong>
        <span>{workspaceName} · {trace.agent} · {l(
          `${trace.injectedUris.length}/${trace.candidates.length} injected · ${trace.injectedTokenCount} tokens`,
          `注入 ${trace.injectedUris.length}/${trace.candidates.length} 条 · ${trace.injectedTokenCount} Token`,
        )}</span>
        {trace.degradedReason ? <em>{l("Degraded", "已降级")}: {trace.degradedReason}</em> : null}
      </div>
      <aside>
        <span className={`openviking-runtime-state ${trace.degradedReason ? "degraded" : "completed"}`}>
          {trace.degradedReason ? l("Degraded", "降级") : l("Complete", "完成")}
        </span>
        <time>{formatDurationMs(trace.durationMs)}</time>
      </aside>
    </article>
  );
}

function RuntimeFact({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactElement;
  label: string;
  value: string;
  detail: string;
}): ReactElement {
  return (
    <article>
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </div>
    </article>
  );
}

function WorkspaceDiagnostics({
  workspace,
  language,
}: {
  workspace: OpenVikingWorkspace;
  language: LanguageMode;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <article className="openviking-runtime-workspace">
      <header>
        <div>
          <strong>{workspace.displayName}</strong>
          <span title={workspace.rootPath}>{workspace.rootPath}</span>
        </div>
        <div>
          <span className={`openviking-runtime-state ${workspace.managed ? "tracking" : "stopped"}`}>
            {workspace.managed ? l("Tracking", "跟踪中") : l("Stopped", "已停止")}
          </span>
          <em>{workspace.managed
            ? l("New turns only", "仅跟踪新对话")
            : l("Memory retained", "记忆已保留")}</em>
        </div>
      </header>
      <div className="openviking-runtime-no-tasks">{workspace.managed
        ? l(
          "Agent hooks append new turns incrementally. OpenViking then runs model-based extraction in the background only when enough context is available, so upload completion is not memory completion.",
          "Agent Hook 会先增量追加新对话；上下文足够时 OpenViking 才在后台运行模型提炼，因此上传完成不代表记忆已经生成。",
        )
        : l(
          "Existing memories remain available, but this directory no longer captures new turns.",
          "已有记忆仍可使用，但此目录不会继续捕获新对话。",
        )}</div>
    </article>
  );
}

function RuntimeStateBadge({ state, language }: { state?: OpenVikingRuntimeState; language: LanguageMode }) {
  return <span className={`openviking-runtime-state ${state ?? "unknown"}`}>{runtimeStateLabel(state, language)}</span>;
}

function HealthBadge({
  health,
  language,
}: {
  health: OpenVikingRuntimeHealth;
  language: LanguageMode;
}) {
  return <span className={`openviking-runtime-state ${health}`}>{healthLabel(health, language)}</span>;
}

function runtimeStateLabel(state: OpenVikingRuntimeState | undefined, language: LanguageMode): string {
  const labels: Record<OpenVikingRuntimeState, [string, string]> = {
    "not-installed": ["Not installed", "未安装"],
    installing: ["Installing", "安装中"],
    stopped: ["Stopped", "已关闭"],
    starting: ["Starting", "启动中"],
    running: ["Running", "运行中"],
    error: ["Error", "异常"],
  };
  const label = state ? labels[state] : ["Loading", "读取中"];
  return localize(language, label[0], label[1]);
}

function healthLabel(
  health: OpenVikingRuntimeHealth | undefined,
  language: LanguageMode,
): string {
  if (health === "healthy") return localize(language, "Healthy", "健康");
  if (health === "unhealthy") return localize(language, "Unhealthy", "不可用");
  if (health === "unknown") return localize(language, "Not checked", "未检查");
  return localize(language, "Not running", "未运行");
}

function triggerLabel(trigger: string, language: LanguageMode): string {
  const labels: Record<string, [string, string]> = {
    "explicit-remember": ["Explicit remember", "明确记住"],
    "token-threshold": ["Token threshold", "Token 阈值"],
    idle: ["Idle flush", "空闲提交"],
    compact: ["Before compact", "压缩前提交"],
    "session-end": ["Session end", "会话结束"],
    manual: ["Manual", "手动"],
  };
  const label = labels[trigger];
  return label ? localize(language, label[0], label[1]) : trigger;
}

function phaseLabel(phase: string, language: LanguageMode): string {
  const labels: Record<string, [string, string]> = {
    append: ["Append turns", "追加 Turn"],
    commit: ["Commit accepted", "提交已接收"],
    summary: ["Summary", "摘要"],
    "long-term-memory": ["Long-term memory", "长期记忆"],
    experience: ["Experience extraction", "经验提炼"],
    vectorize: ["Vector indexing", "向量索引"],
    verify: ["Verify and reconcile", "校验与对账"],
    recall: ["Automatic recall", "自动召回"],
    search: ["Memory search", "记忆搜索"],
    read: ["Memory read", "记忆读取"],
    save: ["Memory save", "记忆保存"],
    delete: ["Memory delete", "记忆删除"],
    feedback: ["Memory feedback", "记忆反馈"],
  };
  const label = labels[phase];
  return label ? localize(language, label[0], label[1]) : phase;
}

function commitStateLabel(state: OpenVikingCommitRun["state"], language: LanguageMode): string {
  if (state === "running") return localize(language, "Running", "进行中");
  if (state === "completed") return localize(language, "Complete", "完成");
  return localize(language, "Failed", "失败");
}

function operationStateLabel(
  status: OpenVikingOperationEvent["status"],
  language: LanguageMode,
): string {
  const labels: Record<OpenVikingOperationEvent["status"], [string, string]> = {
    started: ["Started", "已开始"],
    completed: ["Complete", "完成"],
    failed: ["Failed", "失败"],
    degraded: ["Degraded", "降级"],
    skipped: ["Skipped", "跳过"],
  };
  return localize(language, labels[status][0], labels[status][1]);
}

function shortId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value;
}

function formatDurationMs(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.floor((durationMs % 60_000) / 1_000)}s`;
}

async function readDiagnostics(): Promise<{
  snapshot: OpenVikingDiagnosticsSnapshot;
  compatibilityMode: boolean;
}> {
  const api = window.sessionSearch;
  if (typeof api.getOpenVikingDiagnostics === "function") {
    return {
      snapshot: await api.getOpenVikingDiagnostics(),
      compatibilityMode: false,
    };
  }
  const snapshot = await api.getOpenVikingMemorySnapshot();
  return {
    compatibilityMode: true,
    snapshot: {
      capturedAt: new Date().toISOString(),
      runtime: {
        status: snapshot.runtime,
        health: snapshot.runtime.state === "running" ? "unknown" : "not-running",
        ...(snapshot.runtime.port === undefined ? {} : { port: snapshot.runtime.port }),
        events: [],
      },
      model: snapshot.model,
      workspaces: snapshot.workspaces,
      control: {
        recentEvents: [],
        recentRecallTraces: [],
        recentCommits: [],
      },
    },
  };
}

async function restartRuntime(): Promise<void> {
  const api = window.sessionSearch;
  if (typeof api.restartOpenVikingRuntime === "function") {
    await api.restartOpenVikingRuntime();
    return;
  }
  await api.stopOpenVikingRuntime();
  await api.startOpenVikingRuntime();
}

function formatTime(value: string, language: LanguageMode): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatDuration(seconds: number | undefined, language: LanguageMode): string {
  if (seconds === undefined) return localize(language, "Not running", "未运行");
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return localize(language, `${days}d ${hours}h`, `${days} 天 ${hours} 小时`);
  if (hours > 0) return localize(language, `${hours}h ${minutes}m`, `${hours} 小时 ${minutes} 分`);
  return localize(language, `${minutes}m ${seconds % 60}s`, `${minutes} 分 ${seconds % 60} 秒`);
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
