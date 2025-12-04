import { printPumpGuardBanner } from "./banner";

export async function runReport(): Promise<void> {
  printPumpGuardBanner("report");

  console.log("📊 PumpGuard REPORT mode (Phase 1)");
  console.log("");
  console.log("Right now this is a placeholder.");
  console.log("Next steps for REPORT mode will be:");
  console.log("  • Read pumpguard-report.csv / TSV");
  console.log("  • Aggregate stats on Pump.fun launches");
  console.log("  • Highlight spicy/risky patterns for you");
  console.log("");
  console.log("For now, REPORT mode just proves the CLI wiring works.");
}
