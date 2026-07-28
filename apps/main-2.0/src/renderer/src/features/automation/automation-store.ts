import type { AppSnapshot } from "../../../../automation/contracts";
import type { AutomationChange } from "../../../../shared/ipc/automation";
import { applyAutomationChange } from "./automation-change";

type StoreListener = () => void;

export class AutomationStore {
  private snapshotValue: AppSnapshot;
  private sequence: number | undefined;
  private readonly listeners = new Set<StoreListener>();

  constructor(initial: AppSnapshot) {
    this.snapshotValue = initial;
  }

  getSnapshot = (): AppSnapshot => this.snapshotValue;

  subscribe = (listener: StoreListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  replace(next: AppSnapshot): void {
    this.sequence = undefined;
    this.snapshotValue = next;
    this.notify();
  }

  applyChange(change: AutomationChange): boolean {
    const application = applyAutomationChange(this.snapshotValue, change, this.sequence);
    this.sequence = application.sequence;
    if (application.resyncRequired) return false;
    if (application.snapshot === this.snapshotValue) return true;
    this.snapshotValue = application.snapshot;
    this.notify();
    return true;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
