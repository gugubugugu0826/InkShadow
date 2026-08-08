import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { InkIcon, inkIconNames, type InkIconProps } from "../src";

describe("InkIcon", () => {
  it("uses a required accessible name for a meaningful icon", () => {
    render(<InkIcon name="home" label="创作首页" />);

    const icon = screen.getByRole("img", { name: "创作首页" });
    expect(icon).toHaveAttribute("data-icon", "home");
    expect(icon).toHaveAttribute("stroke", "currentColor");
    expect(icon).toHaveAttribute("stroke-width", "1.75");
    expect(icon).toHaveAttribute("width", "24");
    expect(icon).toHaveAttribute("height", "24");
    expect(icon).toHaveAttribute("focusable", "false");
  });

  it("hides explicitly decorative icons from the accessibility tree", () => {
    const { container } = render(<InkIcon name="sparkles" decorative />);

    const icon = container.querySelector("svg");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).not.toHaveAttribute("role");
    expect(icon).not.toHaveAttribute("aria-label");
  });

  it("ships all 26 DESIGN v0.3.1b icon names", () => {
    const { container } = render(
      <>
        {inkIconNames.map((name) => (
          <InkIcon key={name} name={name} decorative />
        ))}
      </>,
    );

    expect(inkIconNames).toHaveLength(26);
    expect(container.querySelectorAll("svg.ink-icon")).toHaveLength(26);
    for (const name of inkIconNames) {
      expect(container.querySelector(`[data-icon="${name}"]`)).toBeInTheDocument();
    }
  });

  it("rejects an empty accessible label at runtime", () => {
    const invalidProps = { name: "search", label: "" } as InkIconProps;

    expect(() => render(<InkIcon {...invalidProps} />)).toThrow(
      "InkIcon requires a non-empty accessible label unless decorative is true.",
    );
  });
});
