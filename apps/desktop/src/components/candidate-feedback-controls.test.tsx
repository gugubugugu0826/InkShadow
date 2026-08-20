import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CandidateFeedbackControls } from "./candidate-feedback-controls";

describe("candidate feedback controls", () => {
  it("submits an ordinary-language option without requiring a prompt", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<CandidateFeedbackControls onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: "让对话更自然" }));
    await user.click(screen.getByRole("button", { name: "记住这次意见" }));

    expect(onSubmit).toHaveBeenCalledWith({
      feedbackCode: "natural_dialogue",
      customFeedback: null,
    });
    expect(screen.getByText("这次意见已记下")).toBeInTheDocument();
  });

  it("accepts custom feedback and leaves the candidate text untouched", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<CandidateFeedbackControls onSubmit={onSubmit} />);

    await user.type(screen.getByRole("textbox", { name: /自定义意见/u }), "不要用总结句收尾");
    await user.click(screen.getByRole("button", { name: "记住这次意见" }));

    expect(onSubmit).toHaveBeenCalledWith({
      feedbackCode: null,
      customFeedback: "不要用总结句收尾",
    });
  });

  it("does not expose an uncontrolled failure message in the ordinary candidate UI", async () => {
    const user = userEvent.setup();
    const rawMessage = "SQLITE_CONSTRAINT candidate-feedback-row-019f-secret";
    render(<CandidateFeedbackControls onSubmit={() => Promise.reject(new Error(rawMessage))} />);

    await user.click(screen.getByRole("button", { name: "让对话更自然" }));
    await user.click(screen.getByRole("button", { name: "记住这次意见" }));

    expect(await screen.findByRole("alert")).toBeVisible();
    expect(document.body).not.toHaveTextContent(rawMessage);
  });
});
