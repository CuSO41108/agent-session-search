import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapApplicationPaths, type ApplicationPathApi } from "./app-path-bootstrap";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeApp(defaults: Record<string, string>): ApplicationPathApi & { paths: Map<string, string> } {
  const paths = new Map(Object.entries(defaults));
  return {
    paths,
    getPath(name) {
      const value = paths.get(name);
      if (!value) throw new Error(`Missing ${name}`);
      return value;
    },
    setPath(name, value) {
      paths.set(name, value);
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("bootstrapApplicationPaths", () => {
  it("keeps HOME, app data, user data, and temp inside explicit test roots", () => {
    const root = temporaryDirectory("agent-recall-v1-paths-");
    const app = fakeApp({
      home: "/real/home",
      appData: "/real/app-data",
      userData: "/real/user-data",
      temp: "/real/temp",
    });

    const paths = bootstrapApplicationPaths({
      app,
      productName: "AgentRecall",
      env: {
        AGENT_RECALL_HOME_DIR: path.join(root, "home"),
        AGENT_RECALL_APP_DATA_DIR: path.join(root, "app-data"),
        AGENT_RECALL_USER_DATA_DIR: path.join(root, "user-data"),
        AGENT_RECALL_TEMP_DIR: path.join(root, "temp"),
      },
      platform: "darwin",
    });

    expect(paths).toEqual({
      home: path.join(root, "home"),
      appData: path.join(root, "app-data"),
      userData: path.join(root, "user-data"),
      temp: path.join(root, "temp"),
    });
    expect(Object.values(paths).every((value) => fs.statSync(value).isDirectory())).toBe(true);
    expect(app.paths.get("userData")).toBe(paths.userData);
  });

  it("rebases app data and user data when only an isolated HOME is provided", () => {
    const root = temporaryDirectory("agent-recall-v1-home-");
    const app = fakeApp({
      home: "/real/home",
      appData: "/real/app-data",
      userData: "/real/user-data",
      temp: path.join(root, "temp"),
    });

    const paths = bootstrapApplicationPaths({
      app,
      productName: "AgentRecall",
      env: { AGENT_RECALL_HOME_DIR: root },
      platform: "darwin",
    });

    expect(paths.appData).toBe(path.join(root, "Library", "Application Support"));
    expect(paths.userData).toBe(path.join(paths.appData, "AgentRecall"));
  });

  it("migrates legacy data only inside the selected app-data root", () => {
    const root = temporaryDirectory("agent-recall-v1-legacy-");
    const appData = path.join(root, "app-data");
    const legacy = path.join(appData, "Agent-Session-Search");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "config.json"), "legacy");
    const app = fakeApp({ home: root, appData, userData: "/real/user-data", temp: path.join(root, "temp") });

    const paths = bootstrapApplicationPaths({
      app,
      productName: "AgentRecall",
      legacyProductNames: ["Agent-Session-Search"],
      env: {
        AGENT_RECALL_HOME_DIR: root,
        AGENT_RECALL_APP_DATA_DIR: appData,
        AGENT_RECALL_TEMP_DIR: path.join(root, "temp"),
      },
      platform: "darwin",
    });

    expect(paths.userData).toBe(path.join(appData, "AgentRecall"));
    expect(fs.readFileSync(path.join(paths.userData, "config.json"), "utf8")).toBe("legacy");
  });
});
