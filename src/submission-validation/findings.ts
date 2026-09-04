import { FINDING_RULE_BYTES, oneLineMessage } from "./artifact-schema.js";
import type { ValidationFinding, ValidationPhase } from "./contracts.js";

/**
 * The one door every finding goes through, and therefore the place the report
 * schema's rules are applied. The trusted publisher re-parses the report and
 * refuses any finding whose rule or message is not a single NFC line free of
 * control characters and inside the schema's byte bounds — and that refusal is
 * terminal for a *passing* validation, since rerunning it produces the same
 * bytes again. Sanitizing here rather than at each call site keeps a
 * transcript tail, a thrown error's `message` or an NFD file name from costing
 * the submission its publication; phases stay free to interpolate whatever
 * they actually saw.
 */
export class FindingCollector {
  readonly violations: ValidationFinding[] = [];
  readonly warnings: ValidationFinding[] = [];

  constructor(private readonly phase: ValidationPhase) {}

  violate(rule: string, message: string): void {
    this.violations.push(this.finding(rule, message));
  }

  warn(rule: string, message: string): void {
    this.warnings.push(this.finding(rule, message));
  }

  absorb(other: FindingCollector): void {
    this.violations.push(...other.violations);
    this.warnings.push(...other.warnings);
  }

  get failed(): boolean {
    return this.violations.length > 0;
  }

  /** Rules are literals everywhere today, but they go through the same
   * sanitizer as the message so the guarantee holds for the whole finding
   * rather than for the half that happened to be remembered. */
  private finding(rule: string, message: string): ValidationFinding {
    return {
      phase: this.phase,
      rule: oneLineMessage(rule, { maxBytes: FINDING_RULE_BYTES }),
      message: oneLineMessage(message),
    };
  }
}
