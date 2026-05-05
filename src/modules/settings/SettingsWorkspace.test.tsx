// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildDefaultState } from "../../core/defaults";
import { SettingsWorkspace } from "./SettingsWorkspace";

describe("SettingsWorkspace strategy planner", () => {
  it("lets the user change the workload primary route and failure behavior", () => {
    const onUpdateWorkloadStrategy = vi.fn();
    const onUpdateWorkloadStrategyRoute = vi.fn();
    const baseState = buildDefaultState([]);
    const state = {
      ...baseState,
      runtimeNodes: baseState.runtimeNodes.map((node) =>
        node.id === "node-gx10-qwen"
          ? {
              ...node,
              endpoint: "http://gx10.local:30000/v1",
              supportedModels: ["qwen3:4b"],
              healthState: "ready" as const,
            }
          : node,
      ),
    };

    render(
      <SettingsWorkspace
        state={state}
        settingsSection="strategy"
        settingsNotice={null}
        providerDiagnostics={[]}
        providerDiagnosticsBusy={false}
        activeProviderProbeId={null}
        providerSmokeResults={{}}
        providerSmokeBusyId={null}
        providerDrafts={{}}
        memoryServiceStatus={null}
        memoryServiceBusy={false}
        memoryServiceLastResult={null}
        onSettingsSectionChange={vi.fn()}
        onUpdateProvider={vi.fn()}
        onCreateProvider={vi.fn()}
        onUpdateWorkloadStrategy={onUpdateWorkloadStrategy}
        onUpdateWorkloadStrategyRoute={onUpdateWorkloadStrategyRoute}
        onProviderDraftChange={vi.fn()}
        onSaveProviderSecret={vi.fn()}
        onProbeProvider={vi.fn()}
        onProbeAllProviders={vi.fn()}
        onSetupProvider={vi.fn()}
        onSmokeTestProvider={vi.fn()}
        onRefreshMemoryServiceStatus={vi.fn()}
        onStartMemoryService={vi.fn()}
        onStopMemoryService={vi.fn()}
      />,
    );

    const routineCard = screen.getByText("Routine Background Work").closest("article");
    expect(routineCard).toBeTruthy();
    const controls = routineCard!.querySelectorAll("select");

    fireEvent.change(controls[0], { target: { value: "shared-local::node-gx10-qwen::qwen3:4b" } });
    fireEvent.change(controls[2], { target: { value: "hard-stop" } });

    expect(onUpdateWorkloadStrategyRoute).toHaveBeenCalledWith(
      "strategy-routine-background",
      "shared-local::node-gx10-qwen::qwen3:4b",
    );
    expect(onUpdateWorkloadStrategy).toHaveBeenCalledWith("strategy-routine-background", {
      hardStopWhenNoFallback: true,
    });
  });
});
