const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface ProgressOutput {
  readonly isTTY?: boolean;
  write(chunk: string): unknown;
}

export class LoadingLine {
  private frame = 0;
  private active = false;
  private previous?: string;

  constructor(private readonly output: ProgressOutput) {}

  update(message: string): void {
    if (this.output.isTTY === true) {
      const indicator = spinner[this.frame % spinner.length]!;
      this.frame += 1;
      this.output.write(`\r\u001B[2K${indicator} ${message}`);
      this.active = true;
    } else if (message !== this.previous) {
      this.output.write(`${message}\n`);
    }
    this.previous = message;
  }

  clear(): void {
    if (this.active) this.output.write("\r\u001B[2K");
    this.active = false;
  }
}
