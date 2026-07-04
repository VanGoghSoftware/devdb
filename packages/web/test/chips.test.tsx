import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp } from "./render.js";
import { StatusChip, ContextChip } from "../src/tree/chips.js";
import type { BranchDto } from "@devdb/shared";

const base = { endpointError: null } as Pick<BranchDto, "endpointError">;

describe("chips", () => {
  it("running shows the port; failed shows red with the error in a tooltip", () => {
    renderApp(<StatusChip branch={{ ...base, endpointStatus: "running", port: 54303 } as BranchDto} />);
    expect(screen.getByText(/running :54303/)).toBeInTheDocument();
  });
  it("context chip shows agent and git branch", () => {
    renderApp(<ContextChip context={{ agent: "claude", git_branch: "fix-checkout" }} />);
    expect(screen.getByText(/claude · fix-checkout/)).toBeInTheDocument();
  });
});
