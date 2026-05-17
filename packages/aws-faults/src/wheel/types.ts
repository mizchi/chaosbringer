/**
 * Wheel of Misfortune (WoM) types.
 *
 * WoM is the on-call training format described in Google's SRE Workbook
 * (chapter "Training Site Reliability Engineers", section "Disaster
 * Role-Playing"). A facilitator picks a scenario from a wheel, gives the
 * trainee a vague initial alert, and role-plays the system response as
 * the trainee investigates. The trainee is graded on PROCESS, not just
 * outcome — did they look at telemetry before acting? did they form a
 * hypothesis before changing code? did they roll back broken changes?
 *
 * Our adaptation:
 *   - The "system" is real (patched kumo + target app), so no facilitator
 *     needs to fake the system's response — the agent's actions hit reality.
 *   - But the *alerting* layer is faked, because real alert streams are
 *     vague, drip in over time, and contain red herrings. We give the
 *     agent a real-looking PagerDuty page, schedule follow-up pages, and
 *     score the resulting transcript.
 *
 * Wraps `Drill` rather than replacing it: the drill IS the underlying
 * fault profile, the scenario adds the alerting + scoring + debrief layer.
 */
import type { Drill, DrillReport } from "../orchestrator.ts";

export interface PageEvent {
  /** Seconds after scenario start (post-baseline) when this page fires. */
  atSec: number;
  /** Page severity. "info" is a heads-up; "page" is a wake-the-on-call event. */
  severity: "info" | "warn" | "page";
  /** Plain-text body, as it would appear in PagerDuty / Slack #alerts. */
  text: string;
}

export interface Scenario {
  id: string;
  /** Short title shown in catalogs and debrief reports. */
  title: string;
  /**
   * Initial alert text. Should be VAGUE — what a real PagerDuty notification
   * looks like, not a debugging brief. Avoid mentioning the underlying AWS
   * service unless that's literally what the customer-facing alert would say.
   */
  initialAlert: string;
  /**
   * The chaos drill driving the actual fault. Usually one of the
   * `incidents/*` replays; can be a custom drill for novel scenarios.
   */
  drill: Drill;
  /**
   * The ground truth — what's actually happening under the hood. Hidden
   * from the agent during the scenario; included in the debrief.
   */
  groundTruth: string;
  /**
   * Mid-scenario pages. Fire on a schedule. Useful for modeling cascading
   * incidents where the second alert lands while the first is still being
   * investigated.
   */
  pages?: PageEvent[];
  /**
   * Plausible-sounding but WRONG hypotheses. If the agent's transcript
   * mentions one (matched by case-insensitive substring), it's logged in
   * the debrief as a red-herring chase — not necessarily a deduction.
   */
  redHerrings?: { hypothesis: string; matchKeyword: string }[];
  /**
   * Investigation steps the scenario author considers part of an "ideal
   * path." Used only in the debrief — the agent is not steered.
   */
  idealPath?: string[];
  /**
   * Scoring rubric. Each criterion gets a binary verdict and contributes
   * to the total score. Authors should keep criteria small (5-10) and
   * focus on PROCESS over outcome.
   */
  rubric: RubricCriterion[];
}

export interface RubricCriterion {
  id: string;
  /** Short description shown in the debrief. */
  description: string;
  /** Weight in the total score; conventionally 0..5. */
  weight: number;
  /** Returns true if the agent satisfied this criterion. */
  check: (ctx: ScoringContext) => boolean;
  /** Optional explanation rendered in the debrief when failed. */
  failHint?: string;
}

export interface ScoringContext {
  /** Full agent transcript, joined into one searchable string. */
  transcript: string;
  /** Raw list of tool-use events with their inputs. */
  toolUses: ToolUseRecord[];
  /** Drill outcome — SLO curve, recovery success. */
  drillReport: DrillReport;
  /** Scenario the agent ran. */
  scenario: Scenario;
  /**
   * Optional pre-read journal-file contents. The runner reads any files
   * referenced by scenario rubric criteria and stuffs them here so
   * `RubricCriterion.check` can stay synchronous.
   */
  journalContents?: string[];
  /**
   * Optional post-run probe results (e.g. customerImpactRecovered's
   * external-endpoint probe). Same rationale as journalContents: keep
   * check() sync, do async work in the runner.
   */
  postRunProbes?: Record<string, { rate: number; sampleN: number }>;
  /**
   * Snapshot of kumo's /kumo/chaos/rules at scoring time. Used by
   * `chaosRulesPreserved` to detect "agent disabled the chaos to make
   * SLO pass" cheating.
   */
  postRunChaosSnapshot?: {
    rules: { id: string }[];
    stats: { ruleId: string; matched: number; skipped: number }[];
  };
}

export interface ToolUseRecord {
  /** Tool name (Bash, Read, Edit, etc.) */
  name: string;
  /** Tool input as a normalized string (e.g. the bash command, or file path). */
  input: string;
  /** Wall-clock seconds since scenario start. */
  atSec: number;
}

export interface CriterionVerdict {
  id: string;
  description: string;
  passed: boolean;
  weight: number;
  failHint?: string;
}

export interface ScenarioReport {
  scenarioId: string;
  passed: boolean;
  /** Sum of weights of passed criteria divided by total weight. */
  score: number;
  /** Maximum possible score (always 1, but useful for documentation). */
  maxScore: number;
  criteria: CriterionVerdict[];
  /** Substring matches against scenario.redHerrings. */
  redHerringsHit: string[];
  /** Underlying drill report. */
  drillReport: DrillReport;
  /** The transcript that was scored. */
  transcript: string;
  toolUses: ToolUseRecord[];
  /** Pre-rendered Markdown debrief, ready to print or save. */
  debrief: string;
}
