import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import {
  Box,
  CircleStop,
  Cpu,
  Download,
  Play,
  RefreshCw,
} from "lucide-react";

import type {
  AppSettings,
  AppSettingsUpdate,
} from "../../../../core/platform";
import {
  OPENVIKING_EXTRACTION_REASONING_EFFORTS,
  type OpenVikingExtractionReasoningEffort,
} from "../../../../core/openviking-settings";
import type {
  OpenVikingMemorySnapshot,
  OpenVikingRuntimeInstallPhase,
} from "../../../../core/openviking-memory";
import { CURRENT_CODEX_MODELS } from "../../../../automation/engine/shared/models";
import { localize, type LanguageMode } from "../../language";

type ComponentAction = "runtime" | "model" | "start" | "stop" | null;

export function OpenVikingMemorySettings({
  language,
  settings,
  saving,
  onSettingsChange,
}: {
  language: LanguageMode;
  settings: AppSettings | null;
  saving: boolean;
  onSettingsChange: (settings: AppSettingsUpdate) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const enabled = Boolean(settings?.openVikingMemoryEnabled);
  const [snapshot, setSnapshot] = useState<OpenVikingMemorySnapshot | null>(null);
  const [action, setAction] = useState<ComponentAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [extractionModel, setExtractionModel] = useState(settings?.openVikingExtractionModel ?? "");
  const [codexProviderModel, setCodexProviderModel] = useState("");

  const refresh = useCallback(async () => {
    setSnapshot(await window.sessionSearch.getOpenVikingMemorySnapshot());
  }, []);

  useEffect(() => {
    void refresh().catch((cause) => setError(errorMessage(cause)));
  }, [refresh]);

  useEffect(() => {
    setExtractionModel(settings?.openVikingExtractionModel ?? "");
  }, [settings?.openVikingExtractionModel]);

  useEffect(() => {
    if (settings?.summarySource !== "codex") {
      setCodexProviderModel("");
      return;
    }
    let cancelled = false;
    void window.sessionSearch.getCodexConfig()
      .then((config) => {
        if (!cancelled) setCodexProviderModel(config.activeModel.trim());
      })
      .catch(() => {
        if (!cancelled) setCodexProviderModel("");
      });
    return () => {
      cancelled = true;
    };
  }, [settings?.summarySource]);

  useEffect(() => {
    if (
      action !== "runtime"
      && action !== "start"
      && snapshot?.runtime.state !== "installing"
      && snapshot?.runtime.state !== "starting"
    ) return;
    const timer = window.setInterval(() => {
      void refresh().catch((cause) => setError(errorMessage(cause)));
    }, 500);
    return () => window.clearInterval(timer);
  }, [action, refresh, snapshot?.runtime.state]);

  const run = async (nextAction: Exclude<ComponentAction, null>, operation: () => Promise<unknown>) => {
    setAction(nextAction);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  };

  const runtimeState = snapshot?.runtime.state ?? "not-installed";
  const runtimeProgress = snapshot?.runtime.progress;
  const runtimePercent = runtimeProgress?.totalBytes
    ? Math.min(100, Math.round(
      ((runtimeProgress.downloadedBytes ?? 0) / runtimeProgress.totalBytes) * 100,
    ))
    : null;
  const runtimeDownloadedMb = runtimeProgress?.downloadedBytes === undefined
    ? null
    : (runtimeProgress.downloadedBytes / 1_000_000).toFixed(1);
  const runtimeProgressSize = runtimeDownloadedMb === null
    ? null
    : runtimeProgress?.totalBytes
      ? `${runtimeDownloadedMb} / ${(runtimeProgress.totalBytes / 1_000_000).toFixed(1)} MB`
      : runtimeProgress?.phase === "packaging-runtime"
        ? l(`Generated ${runtimeDownloadedMb} MB`, `已生成 ${runtimeDownloadedMb} MB`)
        : `${runtimeDownloadedMb} MB`;
  const runtimeDownloadSpeed = runtimeProgress?.bytesPerSecond
    ? `${(runtimeProgress.bytesPerSecond / 1_000_000).toFixed(1)} MB/s`
    : null;
  const runtimeInstalledSize = snapshot?.runtime.installedBytes === undefined
    ? null
    : (snapshot.runtime.installedBytes / 1_000_000).toFixed(1);
  const modelInstalled = Boolean(snapshot?.model.installed);
  const controlsDisabled = !enabled || saving || action !== null;
  const summarySource = settings?.summarySource ?? "custom";
  const summaryConfig = settings?.summaryApiConfig;
  const providerName = summarySource === "codex"
    ? "Codex"
    : summarySource === "claude"
      ? "Claude CLI"
      : summaryConfig?.customProviderName || l("Custom Provider", "自定义 Provider");
  const providerModel = summarySource === "codex"
    ? codexProviderModel
    : summarySource === "custom"
      ? summaryConfig?.customModel.trim() ?? ""
      : "";
  const selectedExtractionModel = extractionModel.trim() || providerModel;
  const codexFamilyProvider = summarySource === "codex"
    || summaryConfig?.customProviderId === "codexzh"
    || providerName.toLowerCase().includes("codex");
  const extractionModelOptions = Array.from(new Set([
    selectedExtractionModel,
    providerModel,
    ...(codexFamilyProvider ? CURRENT_CODEX_MODELS.map((model) => model.id) : []),
  ].filter(Boolean)));
  const selectedCodexModel = CURRENT_CODEX_MODELS.find(
    (model) => model.id.toLowerCase() === selectedExtractionModel.toLowerCase(),
  );
  const reasoningEffortOptions = selectedCodexModel?.reasoningEfforts
    ?.filter((effort): effort is OpenVikingExtractionReasoningEffort =>
      OPENVIKING_EXTRACTION_REASONING_EFFORTS.includes(
        effort as OpenVikingExtractionReasoningEffort,
      ))
    ?? ["low", "medium", "high"];
  const missingCustomProviderFields = summarySource !== "custom"
    ? []
    : [
        !summaryConfig?.customBaseUrl.trim() ? l("URL", "地址") : null,
        !summaryConfig?.customApiKey.trim() ? "API Key" : null,
        !(extractionModel.trim() || summaryConfig?.customModel.trim()) ? l("model", "模型") : null,
      ].filter((field): field is string => Boolean(field));
  const extractionProviderError = summarySource === "claude"
    ? l(
      "Claude CLI is not currently supported for memory extraction. Choose Codex or a custom OpenAI Chat Provider on the Provider page.",
      "记忆提取暂不支持 Claude CLI，请在 Provider 页面改用 Codex 或自定义 OpenAI Chat Provider。",
    )
    : summarySource === "custom" && summaryConfig?.customApiFormat !== "openai_chat"
      ? l(
        "Memory extraction currently supports custom OpenAI Chat Providers only.",
        "记忆提取暂不支持该格式，目前仅支持自定义 OpenAI Chat Provider。",
      )
      : missingCustomProviderFields.length > 0
        ? l(
          `Missing ${missingCustomProviderFields.join(", ")} in the summary Provider.`,
          `缺少 ${missingCustomProviderFields.join("、")}，请前往 Provider 页面补充。`,
        )
        : null;
  return (
    <section className="settings-pane openviking-settings-pane">
      <header className="settings-pane-head">
        <h3>{l("Directory memory", "目录记忆")}</h3>
        <p>{l(
          "Give selected directories isolated long-term memory powered by a locally managed OpenViking service.",
          "使用本机托管的 OpenViking，为你选定的目录提供彼此隔离的长期记忆。",
        )}</p>
      </header>

      <label className="settings-field settings-toggle openviking-master-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">{l("Enable directory memory", "启用目录记忆")}</span>
          <span className="settings-field-sub">{l(
            "Off by default. Enabling it does not select any directory or download a component automatically.",
            "默认关闭。开启后也不会自动选择目录或下载组件。",
          )}</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={enabled}
          disabled={!settings || saving}
          onChange={(event) => onSettingsChange({ openVikingMemoryEnabled: event.currentTarget.checked })}
        />
      </label>

      <div className="openviking-component-list">
        <div className="openviking-component-card">
          <span className="openviking-component-icon"><Box size={18} /></span>
          <div>
            <strong>OpenViking {snapshot?.runtime.version ?? "0.4.11-r3"}</strong>
            <span>{runtimeInstalledSize
              ? `${runtimeInstalledSize} / ${runtimeInstalledSize} MB`
              : l(
                "About 260–320 MB download",
                "下载约 260–320 MB",
              )}</span>
            {runtimeState === "installing" ? (
              <div className="openviking-runtime-progress">
                <div className="openviking-runtime-progress-meta">
                  <span>{runtimeLabel(runtimeState, language, runtimeProgress?.phase)}</span>
                  <span>
                    {runtimeProgressSize}
                    {runtimePercent === null ? null : ` · ${runtimePercent}%`}
                    {runtimeDownloadSpeed ? ` · ${runtimeDownloadSpeed}` : null}
                  </span>
                </div>
                <div className="openviking-runtime-progress-track" aria-hidden="true">
                  <span
                    className={runtimePercent === null
                      ? "openviking-runtime-progress-fill indeterminate"
                      : "openviking-runtime-progress-fill"}
                    style={runtimePercent === null ? undefined : { width: `${runtimePercent}%` }}
                  />
                </div>
              </div>
            ) : null}
          </div>
          <span className={`openviking-status ${runtimeState}`}>
            {runtimeLabel(runtimeState, language, runtimeProgress?.phase)}
          </span>
          {runtimeState === "not-installed" ? (
            <button
              type="button"
              className="settings-action-button"
              disabled={controlsDisabled}
              onClick={() => void run("runtime", () => window.sessionSearch.installOpenVikingRuntime())}
            >
              {action === "runtime" ? <RefreshCw size={14} className="spin" /> : <Download size={14} />}
              {l("Download", "下载")}
            </button>
          ) : runtimeState === "running" ? (
            <button
              type="button"
              className="settings-action-button"
              disabled={controlsDisabled}
              onClick={() => void run("stop", () => window.sessionSearch.stopOpenVikingRuntime())}
            >
              {action === "stop" ? <RefreshCw size={14} className="spin" /> : <CircleStop size={14} />}
              {l("Stop", "停止")}
            </button>
          ) : (
            <button
              type="button"
              className="settings-action-button"
              disabled={controlsDisabled || !modelInstalled}
              onClick={() => void run("start", () => window.sessionSearch.startOpenVikingRuntime())}
            >
              {action === "start" ? <RefreshCw size={14} className="spin" /> : <Play size={14} />}
              {l("Start", "启动")}
            </button>
          )}
        </div>

        <div className="openviking-component-card">
          <span className="openviking-component-icon"><Cpu size={18} /></span>
          <div>
            <strong>BAAI/bge-small-zh-v1.5</strong>
            <span>{l(
              "Local embedding · 47.9 MB · CPU is enough, no dedicated GPU required",
              "本地向量模型 · 47.9 MB · CPU 即可运行，不要求独立显卡",
            )}</span>
          </div>
          <span className={`openviking-status ${modelInstalled ? "running" : "not-installed"}`}>
            {modelInstalled ? l("Downloaded", "已下载") : l("Not downloaded", "未下载")}
          </span>
          {!modelInstalled ? (
            <button
              type="button"
              className="settings-action-button"
              disabled={controlsDisabled}
              onClick={() => void run(
                "model",
                () => window.sessionSearch.installOpenVikingModel("BAAI/bge-small-zh-v1.5"),
              )}
            >
              {action === "model" ? <RefreshCw size={14} className="spin" /> : <Download size={14} />}
              {l("Download 47.9 MB", "下载 47.9 MB")}
            </button>
          ) : null}
        </div>
      </div>

      <div className="openviking-extraction-settings">
        <div className="settings-pane-head compact">
          <h3>{l("Memory extraction", "记忆提取")}</h3>
          <p>{l(
            "Uses the summary Provider configured on the Provider page.",
            "复用 Provider 页面配置的摘要 Provider。",
          )}</p>
        </div>
        <div className={`openviking-extraction-provider${extractionProviderError ? " error" : ""}`}>
          <div>
            <strong>{l("Summary Provider", "摘要 Provider")}</strong>
            <span>{providerName}</span>
          </div>
          <small>{extractionProviderError ?? l("Ready for memory extraction", "可用于记忆提取")}</small>
        </div>
        <div className="openviking-extraction-fields">
          <label className="openviking-extraction-field">
            <span>{l("Extraction model", "提取模型")}</span>
            <select
              value={selectedExtractionModel}
              disabled={!settings || saving}
              onChange={(event) => {
                const model = event.currentTarget.value;
                const modelDefinition = CURRENT_CODEX_MODELS.find((candidate) => candidate.id === model);
                const supportedEfforts = modelDefinition?.reasoningEfforts ?? ["low", "medium", "high"];
                const currentEffort = settings?.openVikingExtractionReasoningEffort ?? "medium";
                const reasoningEffort = supportedEfforts.includes(currentEffort)
                  ? currentEffort
                  : supportedEfforts.includes(modelDefinition?.defaultReasoningEffort ?? "")
                    ? modelDefinition!.defaultReasoningEffort as OpenVikingExtractionReasoningEffort
                    : "medium";
                setExtractionModel(model);
                onSettingsChange({
                  openVikingExtractionModel: model,
                  openVikingExtractionReasoningEffort: reasoningEffort,
                });
              }}
            >
              {!selectedExtractionModel ? (
                <option value="" disabled>{l("Choose a model", "选择模型")}</option>
              ) : null}
              {extractionModelOptions.map((model) => (
                <option key={model} value={model}>
                  {CURRENT_CODEX_MODELS.find((candidate) => candidate.id === model)?.label ?? model}
                </option>
              ))}
            </select>
            <small>{l("Model used to analyze and generate memories.", "用于分析并生成记忆。")}</small>
          </label>
          <label className="openviking-extraction-field">
            <span>{l("Reasoning effort", "推理强度")}</span>
            <select
              value={settings?.openVikingExtractionReasoningEffort ?? "medium"}
              disabled={!settings || saving}
              onChange={(event) => onSettingsChange({
                openVikingExtractionReasoningEffort:
                  event.currentTarget.value as OpenVikingExtractionReasoningEffort,
              })}
            >
              {reasoningEffortOptions.map((effort) => (
                <option key={effort} value={effort}>{effort}</option>
              ))}
            </select>
            <small>{l("Default: medium", "默认：medium")}</small>
          </label>
        </div>
      </div>

      <div className="openviking-integration-settings">
        <div className="settings-pane-head compact">
          <h3>{l("Automatic recall and capture", "自动召回与记忆")}</h3>
          <p>{l(
            "Only events inside managed directories are forwarded. Hook failures never block the agent.",
            "只有受管理目录内的事件会被处理；Hook 失败不会阻断 agent。",
          )}</p>
        </div>
        <IntegrationToggle
          label="Claude Code"
          checked={Boolean(settings?.openVikingClaudeEnabled)}
          disabled={!enabled || !settings || saving}
          onChange={(checked) => onSettingsChange({ openVikingClaudeEnabled: checked })}
        />
        <IntegrationToggle
          label="Codex"
          checked={Boolean(settings?.openVikingCodexEnabled)}
          disabled={!enabled || !settings || saving}
          onChange={(checked) => onSettingsChange({ openVikingCodexEnabled: checked })}
        />
        <IntegrationToggle
          label="OpenCode"
          checked={Boolean(settings?.openVikingOpenCodeEnabled)}
          disabled={!enabled || !settings || saving}
          onChange={(checked) => onSettingsChange({ openVikingOpenCodeEnabled: checked })}
        />
      </div>

      {error ? <div className="openviking-settings-error">{error}</div> : null}
    </section>
  );
}

function IntegrationToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <label className="settings-field settings-toggle openviking-integration-toggle">
      <div className="settings-field-text">
        <span className="settings-field-title">{label}</span>
      </div>
      <input
        type="checkbox"
        className="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}

function runtimeLabel(
  state: OpenVikingMemorySnapshot["runtime"]["state"],
  language: LanguageMode,
  phase?: OpenVikingRuntimeInstallPhase,
): string {
  const l = (en: string, zh: string) => localize(language, en, zh);
  switch (phase) {
    case "resolving-runtime": return l("Checking download", "检查下载");
    case "downloading-python": return l("Downloading runtime base", "下载运行环境");
    case "building-runtime": return l("Installing OpenViking", "安装 OpenViking");
    case "packaging-runtime": return l("Packaging runtime", "打包运行时");
    case "downloading-runtime": return l("Downloading runtime", "下载运行时");
    case "verifying-runtime": return l("Verifying download", "校验下载");
    case "installing-runtime": return l("Installing runtime", "安装运行时");
  }
  switch (state) {
    case "running": return l("Service running", "服务运行中");
    case "stopped": return l("Service stopped", "服务已停止");
    case "installing": return l("Downloading", "下载中");
    case "starting": return l("Starting service", "正在启动服务");
    case "error": return l("Error", "异常");
    default: return l("Not downloaded", "未下载");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
