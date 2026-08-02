import type { ValidationFinding, ValidationPhase } from "./contracts.js";

export class FindingCollector {
  readonly violations: ValidationFinding[] = [];
  readonly warnings: ValidationFinding[] = [];

  constructor(private readonly phase: ValidationPhase) {}

  violate(rule: string, message: string): void {
    this.violations.push({ phase: this.phase, rule, message });
  }

  warn(rule: string, message: string): void {
    this.warnings.push({ phase: this.phase, rule, message });
  }

  absorb(other: FindingCollector): void {
    this.violations.push(...other.violations);
    this.warnings.push(...other.warnings);
  }

  get failed(): boolean {
    return this.violations.length > 0;
  }
}
