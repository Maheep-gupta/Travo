import type { ReactNode } from "react";
import { SETUP_STATE_LABEL, type SetupStep } from "@mc/domain";
import { DemoTag } from "./components.js";
import { IconCheck, IconClock, IconInfo, IconLock } from "./icons.js";
import "./setup.css";

/**
 * The guided setup checklist (spec 11.2). Each step's state is written out
 * next to its icon, so it never depends on colour. Router-free: the caller
 * renders each action, because the first-run page has no router.
 */
export function SetupStepList({ steps, renderAction, label = "Setup steps" }: { steps: readonly SetupStep[]; renderAction: (step: SetupStep) => ReactNode; label?: string }) {
  return (
    <ol className="setup-steps" aria-label={label}>
      {steps.map((step, index) => (
        <li key={step.id} className={`setup-step ss-${step.state}`} aria-current={step.state === "current" ? "step" : undefined}>
          <span className="setup-mark" aria-hidden="true">
            {step.state === "done" ? <IconCheck /> : step.state === "unknown" ? <IconClock /> : step.state === "blocked" ? <IconLock /> : step.optional ? <IconInfo /> : index + 1}
          </span>
          <div className="setup-body">
            <p className="setup-head">
              <span className="setup-title">{step.title}</span>
              <span className="setup-state">
                <span className="sr-only">: </span>
                {SETUP_STATE_LABEL[step.state]}
              </span>
              {step.demo && <DemoTag />}
            </p>
            <p className="setup-detail">{step.detail}</p>
            {step.action && <div className="setup-action">{renderAction(step)}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
