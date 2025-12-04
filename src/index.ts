// src/index.ts
import "dotenv/config";
import chalk from "chalk";
import { printPumpGuardBanner } from "./banner";
import { runWatch } from "./watch";
import { runReport } from "./report";

async function main() {
  const modeArg = process.argv[2]?.toLowerCase();
  const rpcEndpoint = process.env.RPC_ENDPOINT;

  if (!rpcEndpoint) {
    console.error(
      chalk.red(
        "\n❌ ERROR: RPC_ENDPOINT is not set.\nSet it first:\n\n  set RPC_ENDPOINT=YOUR_URL\n"
      )
    );
    process.exit(1);
  }

  switch (modeArg) {
    case "watch":
      printPumpGuardBanner("WATCH", rpcEndpoint);
      await runWatch();
      break;

    case "report":
      printPumpGuardBanner("REPORT", rpcEndpoint);
      await runReport();
      break;

    default:
      console.log(
        chalk.yellow(`
Usage:
  npm run watch     → Start real-time pump.fun transaction stream
  npm run report    → Export TSV/CSV formatted launch report

Example:
  set RPC_ENDPOINT=https://mainnet.helius-rpc.com/?api-key=XXXX
  npm run watch
`)
      );
      process.exit(0);
  }
}

main().catch((err) => {
  console.error(chalk.red("\n❌ PumpGuard crashed:\n"), err);
});
